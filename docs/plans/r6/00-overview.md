# R6 · 总览与执行契约

> 承接 `../r5/00-overview.md`。R5(T17–T22)已全部落地并 commit。
> 基线实证(`40d91ed`):`pnpm typecheck` 全绿;`pnpm test` 50 文件 / 407 项全绿。
>
> **本轮主题:工具执行语义治理 —— 三处 SDK 默认行为与 Eva 的工具实现方式互相放大,
> 产出"静默丢更新"和"永不返回的工具调用"。三档全是收敛在一个装配层的薄改,
> 不动 SDK、不动工具的业务语义。** 施工参考:DeepAgents 与 Claude Code 的实测调研
> (结论已内嵌各任务 §1/§2,原始调研不再单独成文)。

---

## 0. R5 收口确认(代码实证)

| 项                      | 实证                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 子代理审批(T17)         | `apps/server/src/routes/runs.ts` 的 `subagentRequestApproval` 首分支 `isSubagent → granted(auto)`;`tests/subagent-approval.test.ts`                                            |
| repairToolCall(T18)     | `packages/harness/src/agents/repair-tool-call.ts` + `agent.ts:254` 条件装配;`tests/lead-agent-*.test.ts`                                                                       |
| apiKey 加密(T19)        | `enc:v1:` 落库、`~/.eva/.secret-key` 0600;`apps/server/src/services/crypto/`                                                                                                   |
| tool-overflow 治理(T20) | sha1 内容寻址 + LRU + 脱敏 + ANSI 清洗;`packages/harness/src/tools/fs/tool-overflow.ts`                                                                                        |
| usage_records(T21)      | 独立表 + settle 双写,聚合读走 SQL;`70fdee3`                                                                                                                                    |
| maxSteps 100(T22)       | 主/子代理同步,文案带步数与继续路径;`7f7671e`                                                                                                                                   |
| 工程重构(本轮前置)      | `tools.ts` → `tools/build-tool.ts` + `tools/index.ts` 集中出口(`40d91ed`);字段对齐 SDK 命名 `inputSchema`/`needsApproval`(`c96e1e0`);`LeadAgent` → 模块内部 `Agent`(`6708370`) |

---

## 1. 本轮要解决的问题

### 1.1 背景:三个互相放大的默认行为

R5 收口后对 `ai@7.0.64` 工具执行路径做了源码级核读(行号均出自
`node_modules/ai/dist/index.js`,下同),结合 DeepAgents / Claude Code 两个成熟
agent 的实现调研,结论是:**SDK 的两个默认行为(并发执行、超时透传)本身没错,
错的是 Eva 的工具实现方式没有为这两个默认值配套。**

| #   | SDK 默认行为                                     | 源码实证                                                                                                                                                                                               | Eva 没配套的地方                                                                                                                               | 后果                                                                                                                           |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A   | **同一步的多个 tool call 并发执行**              | `executeToolsFromStream`(streamText 路径)在 `model-call-end` 时对 `toolCallsToExecute` 整体 `Promise.all`(:8165);`generateText` 路径 `executeTools` 同款(:6088)                                        | `edit` 是裸的 read-modify-write(readFile → replace → writeFile),`write` 是裸 writeFile;无任何互斥或校验                                        | 模型在一步里发两个同文件 edit → **后写覆盖前写,静默丢更新,两个工具都报成功**                                                   |
| B   | **超时经 abortSignal 传给工具,工具自己负责响应** | `getToolTimeoutMs`(:2216):`timeout` 传数字时工具超时为 `undefined`(数字速记只覆盖模型调用);`mergeAbortSignals`(:2717)把超时折成 `AbortSignal.timeout` 后作为 `options.abortSignal` 传进 execute(:3022) | `build-tool.ts:63` 构造 `ToolExecutionOptions` 时**只挑 toolCallId,abortSignal 被丢弃**;`agent.ts:249` 的 `streamText({...})` 也没传 `timeout` | bash 有自己的 120s 兜底,但 edit/write/read/grep 的 fs 操作、以及未来任何不自带超时的工具,**挂住就是永远挂住**,run 只能整场取消 |
| C   | 无并发上限                                       | 两处 `Promise.all` 均无并发帽                                                                                                                                                                          | Eva 也没有                                                                                                                                     | 模型一步发 20 个 web_search → 20 个并发 HTTP 请求同时打出去;DDG 限流、provider 侧计费脉冲                                      |

三个问题的成熟解法调研结论(细节在各任务 §2):

- **Claude Code 对 A 的解法不是互斥锁,是"乐观校验"**:写工具照常并发,但 edit/write
  前先比对 mtime 快照,变了就报
  _"File has been modified since read"_ 让模型重读重试 —— 拒绝的是基于过期
  状态的写入,而不是并发本身。(v2.1.208 放宽为:old_string 仍唯一命中也可过。)
- **DeepAgents 是反面教材**:write_file 直接 O_TRUNC 落盘,StateBackend 的
  reducer 是 last-write-wins 字典合并 —— **没有任何一致性保护**。langgraph 的
  Send-per-tool-call 真并发 + 裸写盘,丢更新窗口和 Eva 现状一样大。
- **并发上限(对 C)**:Claude Code 的做法是按 `readOnly` 分类 + 每工具
  `isConcurrencySafe()` + 默认帽 10(`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`)。
  Eva 的 `readOnly` 标志已经在 15 个工具上铺好,缺的只是装配层的限流。

### 1.2 A:edit/write 的丢更新窗口(🔴 静默数据损坏)

`edit-tool.ts:31-42` 全过程:

```
31  const content = await fs.readFile(absolute, "utf-8");   ← 读
32  const occurrences = content.split(before).length - 1;
41  const updated = content.replace(before, after);
42  await fs.writeFile(absolute, updated, "utf-8");         ← 写
```

两个 `edit` 调用在 `Promise.all` 里同时进这段:甲读到 v0,乙读到 v0,甲写
v0+a,乙写 v0+b(乙的 replace 基于旧 v0,**甲的结果被整段抹掉**)。两个工具
都返回成功,模型以为两处都改了。`write` 同理(append 模式靠 OS `O_APPEND`
原子性反而不丢行,overwrite 模式是整文件覆盖)。

这不是理论风险:模型对"同一文件改多处"的标准动作就是一步发多个 edit ——
Eva 的 edit 工具 description 里"before must match exactly once"在并发下
形同虚设(两个 edit 的 before 各自基于 v0 都唯一命中,校验拦不住)。

bash 也写文件,但走 shell 子进程,和 fs 工具之间没有共享状态可撞 ——
Claude Code 的 mtime 校验同样覆盖"用户或 linter 在工具间隙改了文件"这类
外部写,所以校验放在 fs 工具层对 bash 误伤极小(见 T23 §6 坑 2)。

### 1.3 B:abortSignal 在装配层被丢弃

SDK 的超时链路(逐行核过):`streamText({ timeout: { toolMs } })` →
`getToolTimeoutMs`(:2216)取出该工具的毫秒数 → `mergeAbortSignals`(:2717)
与顶层 abortSignal 合并成 `AbortSignal.any([...])` → 作为
`options.abortSignal` 传进 `tool.execute`(:3022)。

Eva 的断点在最后一环:`build-tool.ts:59-63`

```ts
// 只需把 SDK 的调用 id 挑出来传给工具;其余 options 不外泄(ToolExecutionOptions 只见 toolCallId)。
const toolCallId = options?.toolCallId ?? `auto-${crypto.randomUUID()}`;
return await definition.execute(parsed, { toolCallId });
```

注释写明了是有意收敛 —— 当时 ToolExecutionOptions 只需要 toolCallId。但这个
决定把 SDK 的超时(和取消)信号一并挡在了门外。现状各工具的自救能力:

| 工具                                           | 自带超时                              | 挂住风险                                        |
| ---------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| bash                                           | `execFile` `timeout: 120_000`         | 无(但取消 run 不能中断它 —— kill 信号没接)      |
| web_fetch                                      | `AbortSignal.timeout(this.timeoutMs)` | 无                                              |
| web_search                                     | 同上(DDG client)                      | 无                                              |
| MCP 工具                                       | `RequestOptions.timeout` 30s          | 无                                              |
| **read_file / grep / list_dir / edit / write** | **无**                                | **NFS / FUSE 挂载、磁盘满等场景下可能永久挂起** |

另一面:工具错误进流不炸循环(SDK 把 execute 的 throw 捕获成 tool-error part
喂回模型),所以一个挂住的 await 不会变成红字 —— 它只是让整场 run 无限停在那,
用户侧表现是"转圈,取消也没用"(cancelByRun reject 的是外层 promise,工具
内部的 fs 调用继续)。

### 1.4 C:无限并发

§1.1 表里 C 的实证:`Promise.all` 对 `toolCallsToExecute` 数组一次性全量
map。模型侧约束(Anthropic 最多 128 个并行 tool use、其他 provider 更少)是
**数量**上限,不是 Eva 侧的**资源**上限:20 个 web_search 同时打 DDG 会被
限流,20 个 read_file 各读 100MB 也没有任何闸。Claude Code 的默认帽是
10(只读),写类靠校验不靠串行 —— Eva 照抄这个分层:只读帽 10、写类不帽
(校验兜底,见 T24 §2)。

---

## 2. R6 范围与顺序

| 任务    | 文档                                                           | 内容                                                                                  | 估时     | 依赖 |
| ------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------- | ---- |
| **T23** | [`T23-write-guard-mtime.md`](./T23-write-guard-mtime.md)       | edit/write 的 mtime 快照校验:Claude Code 式乐观守卫,拒绝基于过期状态的写入            | 0.5–1 天 | —    |
| **T24** | [`T24-concurrency-cap.md`](./T24-concurrency-cap.md)           | 只读工具并发帽(默认 10),装配层限流;web_fetch 补 `readOnly: true`                      | 0.5 天   | —    |
| **T25** | [`T25-abort-signal-timeout.md`](./T25-abort-signal-timeout.md) | `ToolExecutionOptions` 透传 `abortSignal`;bash/web 类接信号;`streamText` 配 `timeout` | 0.5–1 天 | —    |

> **落地记录**:T23 → commit 09c34d9;T25 → 7888d43(bash 组杀实测结论见
> T25 坑 7:execFile 的 detached 不生效,必须 spawn);T24 → 85cc99e。
> 439 测试全绿,三个摘除实验都变红过。

**顺序建议**:T23 先(正确性问题,且 T24/T25 都可能踩到它暴露的既有测试)→
T25 次之(透传是 T24 限流器想要的取消路径,但两者无文件交集,可并行)→
T24 最后(半小时,依赖 readOnly 分类已存在的现状)。三者唯一共同改动点是
`build-tool.ts` / `agent.ts` 装配层,但改动的是不同位置:串行执行最稳。

### 2.1 明确不做

1. **互斥锁 / 串行化写工具**。Claude Code 实证了"并发 + 校验"优于"串行":
   锁会把模型自然批量发的多个 edit 强行排队,还引入死锁面(工具 A 等锁时无法
   被取消)。校验只拒"基于过期状态的写",不拒并发本身。
2. **read-state 追踪**(Claude Code 的第一道闸:记录会话内读过哪些文件,没读过
   就拒绝写)。它是体验优化(逼模型先读再写),不是正确性 —— mtime 校验已经
   覆盖"没读过就写"的并发子集之外的大部分场景。Eva 的 edit description 已有
   "must match exactly once" 约束。留到有实证"模型盲写"案例再做。
3. **edit/write 的文件级锁、跨 run 互斥**。同一 workspace 的两个 run 并发写
   同一文件:tee 不开就不发生(Eva 每个请求一个 run,memory-runtime 的
   additionalTools 是 run-scoped);真发生了 mtime 校验也会拒后到的。跨 run
   一致性是 workspace 调度层的话题,不是工具层。
4. **SDK `timeout` 的 totalMs/stepMs/chunkMs 全家桶**。T25 只配 `toolMs` 与
   per-tool 覆盖 —— 模型调用的超时是 provider 适配器的事(已有各 fetch 自带
   的超时),不归工具执行语义管。
5. **DynamicTool / toModelOutput / 工具流式输出**。与执行语义无关,不在本轮。
6. **usage/成本侧的并发审计**。T21 的 usage_records 已能事后核算,不预埋。

---

## 3. 执行契约

**沿用 `../r1/00-overview.md` §1** + `../r2/00-overview.md` §3 四条 +
`../r3/00-overview.md` §3 两条 + `../r4/00-overview.md` §3 两条 +
`../r5/00-overview.md` §3 两条。开工前必读。

R6 追加三条:

1. **"治理"必须收敛在装配层,不许散进工具实现。** T24 的限流器、T25 的信号
   透传,实现位置都在 `build-tool.ts` / `agent.ts`(与 `withApproval` 同层)。
   判定标准:单个工具文件(除 T23 的 edit/write 自身校验)不出现
   concurrency/abort 相关的新 import。工具只管业务,横切只管装配 —— 这是
   6708370 把 createAgent 收敛成唯一入口时就立下的结构原则。

2. **并发语义必须有"时间窗"级别的测试钉住。** 丢更新、限流、取消,三件事的
   共同点:串行跑全绿,只有真的并发才暴露。测试不允许用"先 await A 再
   await B"冒充并发 —— 必须让两个调用在时间上重叠(T23 用放慢的 mock fs,
   T24 用受控的慢 resolve)。判定标准:把实现的并发帽子摘掉/把校验删掉,
   对应测试必须变红。

3. **abortSignal 是取消协议,不是新超时。** T25 透传的信号语义 =
   "run 被取消" ∪ "SDK 工具超时"。工具响应它的方式是**尽快返回错误文本**
   (进流、模型可见),不是 throw 到外面去炸循环(SDK 会捕成 tool-error
   part,但 Eva 的约定是 `[Tool Error]` 前缀字符串,两条路径都要测)。

---

## 4. 决策记录

### 4.1 为什么是"mtime 乐观校验"而不是锁(对 #A)

三候选的对比(调研结论的浓缩):

| 方案            | 代表            | 优点                                                                | 致命伤                                                                                     |
| --------------- | --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 互斥锁          | —               | 绝不丢更新                                                          | 模型批量 edit 全部串行;取消语义复杂(A 持锁、B 排队,取消 B 不影响 A);跨工具类型要一把全局锁 |
| 乐观校验(mtime) | **Claude Code** | 并发照旧;实现 ~40 行;顺带覆盖"用户/linter 在工具间隙改文件"的外部写 | mtime 粒度(同秒内两次写,fs 精度不够时漏检 —— 用 mtimeMs + size 双因子缓解)                 |
| last-write-wins | DeepAgents      | 零实现                                                              | **就是现状的 bug**                                                                         |

选乐观校验。Claude Code v2.1.208 的放宽逻辑(比对失败但 old_string 仍唯一
命中 → 放行)也一并抄:纯 mtime 拒绝在"读后格式化工具改了行尾"这类场景会
误伤,唯一命中是比 mtime 更强的"我的旧状态还有效"证据。

### 4.2 为什么并发帽只帽只读(对 #C)

写工具不帽的理由:① 它们的正确性由 T23 校验兜底,帽只影响吞吐;②
Claude Code 实证写类也并发(靠两道闸),帽写类是没必要的保守;③ 限流器
统一帽一切会把"edit + read 校验"这类天然成对的调用也排队,纯损。

只读帽 10 的取值:照抄 Claude Code 默认值。它同时是模型侧并行度的合理上界
(再高单步收益递减)与外部服务的礼貌上界(DDG / 搜索 API 限流)。可经
`CreateAgentOptions` 注入,不设环境变量(Eva 的配置面在 server 侧,不在
harness 读 env —— 同 r5 §2.1 #4 的边界判断)。

### 4.3 web_fetch 补 `readOnly: true` 归入 T24 而非顺手改

它是 C 类分类的正确性缺口(fetch 无副作用但没打标),但单独 commit 不成立
(一行改动、无测试面),归入 T24 的分类收口一起测。

---

## 5. 验收总表

| 任务 | 一句话验收                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T23  | 并发两个 edit 打同一文件(测试用受控 mock 放大窗口)→ 后到的那个返回 _"has been modified since read"_ 类错误、文件内容为两个改动的**先到者**、先到者报成功;外部改文件后 edit → 同样被拒;old_string 仍唯一命中时放行(v2.1.208 放宽) |
| T24  | 一步并发 15 个慢只读工具(受控 resolve)→ 观测到的最大同时在飞数 ≤ 10,全部完成、结果无丢失;`web_fetch` 带上 `readOnly: true`;写工具不受帽(两个并发 edit 照常并发,由 T23 兜底)                                                      |
| T25  | 挂一个不响应取消的假工具 → `streamText` 配 `toolMs` 后它在超时点返回 `[Tool Error]` 字符串、循环继续;真取消 run → 已透传信号的工具(bash/web_fetch)在中途返回取消错误而不是等满 120s                                              |
