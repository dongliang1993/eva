# T24 · 只读工具并发帽(readOnly 分类 + 装配层限流)

> 前置:无(建议本轮最后做,T23 先钉住写守卫)。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §1.4、§3、§4.2。
> 施工图:Claude Code 的并发模型 —— 每工具 `isConcurrencySafe()` + 默认帽
> 10(`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`),写类靠校验不靠串行。

**建议 1 个 commit**:`feat(harness)`。限流器是 harness 纯逻辑,server 只在
`agent-factory` 注入一个可选上限(不传 = 默认)。

---

## 1. 问题实证

### 1.1 无帽的实证

SDK(`node_modules/ai/dist/index.js`):

```js
// executeToolsFromStream(streamText 路径,Eva 走这条):
case "model-call-end": {
  await Promise.all(
    toolCallsToExecute.map(async (toolCall) => { ... })   // :8165 —— 全量并发,无帽
```

`generateText` 路径同款(:6088)。两处都没有任何并发计数 —— **模型一步发
N 个 tool call,N 个 execute 同时在飞**。

Eva 侧同样无帽(全仓 grep `Semaphore|p-limit|concurrency` 无命中)。模型侧
的约束是"单响应内 tool use 数量"(Anthropic 上限 128,其他 provider 更小),
那是**消息协议**的上限,不是 Eva 进程的**资源**上限。

### 1.2 现状工具的并发画像

15 个工具的 `readOnly` 现状(全仓 grep 实证):

| 类       | 工具                                                                                              | readOnly   | 并发风险                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| 读       | read_file / list_dir / grep / read_memory_file / search_memory / read_skill / report / web_search | ✅ true    | 无副作用,但**数量**不受控:20 个并发 web_search 同打 DDG → 限流/封禁;20 个 read_file 各读大文件 → 内存脉冲 |
| 写       | bash / write / edit / save_memory / append_memory / update_long_term_memory                       | ❌(无标志) | 正确性由 T23 守卫兜底(§4.2);数量上模型极少批量发写                                                        |
| **缺标** | **web_fetch**                                                                                     | ❌ **缺**  | `web-fetch/tool.ts` 无 `readOnly` 字段 —— fetch 无副作用,该归只读类,现状被当写类对待                      |
| 委派     | subagent                                                                                          | ❌(无标志) | fork 语义,天然"少量后台",模型极少一步发多个;且 runFork 自带后台化                                         |

web_fetch 缺标是分类正确性缺口(`00-overview.md` §4.3):它在 Claude Code
的等价物(read 类 + web)是 `isConcurrencySafe: true`。

### 1.3 成熟实现的做法(Claude Code,调研还原)

- 默认帽 **10**,环境变量可调;
- 并非"全部排队":**只读并行、写类也并行**(正确性靠 T23 式守卫而非串行);
- MCP 工具用协议自带的 `readOnlyHint` 映射 isConcurrencySafe —— **Eva 已有
  同款映射**(`apps/server/src/services/mcp/mcp-client.ts:225` 的
  `annotations?.readOnlyHint === true` → `descriptor.readOnly`),分类面是通的。

---

## 2. 目标设计

### 2.1 帽子的语义:每步一个限流器,只帽只读,写直通

```
同一步 toolCallsToExecute(由 SDK Promise.all 驱动)
  ├─ readOnly 工具 → 经过 limiter.acquire() → execute → release
  └─ 其余工具(写/未标) → 直通 execute(不进队,不计数)
```

三个关键决定:

1. **限流器挂在工具 execute 外面,不动 SDK 的 Promise.all。** 实现位置 =
   `build-tool.ts` 的 execute 包装层(与 `withApproval` 在 agent.ts 的装配
   不同层 —— withApproval 包 AgentTool,限流包 execute;理由:readOnly 是
   AgentTool 的属性,但限流要 per-agent 实例,而 buildTool 是模块级工厂)。
   准确落点:`agent.ts` 的 createAgent 装配处 —— 把每个工具的 execute 包上
   `withConcurrencyCap(tool, limiter)`。与 withApproval 同层同模式,**符合
   r6 契约 §3.1"治理收敛在装配层"**。
2. **per-step 生命周期**:限流器在每次 `run()` 开始时新建,run 结束丢弃。
   不跨 run 共享(两个 run 不该互相抢帽子 —— 那是资源调度层的事);
   同一 run 内跨步共享也不必要(步与步本来就串行),但共享无害且省一次
   构造 —— 取"per-run 一个",与 Agent 实例生命周期对齐最简单。
3. **只帽 readOnly === true。** 未标工具(web_fetch 修标前、subagent)归
   直通类 —— 宁可漏帽不可误帽(把写类误帽进只读队列 = T23 白做)。

### 2.2 限流器实现(~50 行,无依赖)

`packages/harness/src/tools/concurrency-cap.ts`(新增):

```ts
/** 无依赖的信号量。acquire 返回的 release 必须在 finally 里调用。 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}
```

FIFO(`shift`)保证饥饿不上浮。release 幂等防 finally 双调。

### 2.3 装配(createAgent 内)

```ts
// agent.ts createAgent:
const cap = options.readOnlyConcurrency ?? DEFAULT_READ_ONLY_CONCURRENCY; // 10
const limiter = new Semaphore(cap);
const tools = (rest.tools ?? []).map((t) =>
  t.readOnly === true ? withConcurrencyCap(t, limiter) : t,
);
// 与 withApproval 的包装顺序:先限流后审批 —— withApproval(t, ...) 在最外层。
```

包装顺序的理由:审批是一个可能挂很久的人机交互点,若限流在审批外层,
"排队等帽的 9 个只读调用"会占着帽等一个审批弹窗 —— 帽被审批拖死。先包
限流(内层)、再包审批(外层):审批期间不占帽,过审后才 acquire。

`CreateAgentOptions` 增一个可选字段(`agents/types.ts`):

```ts
/** 只读工具的并发上限(每 agent 实例)。默认 10(Claude Code 同款)。 */
readonly readOnlyConcurrency?: number;
```

server 侧不注入(用默认)—— `agent-factory.ts` 零改动;字段留给测试和
将来 workspace 级配置。

### 2.4 web_fetch 补标

`web-fetch/tool.ts` 的 buildTool 定义加 `readOnly: true`(一行)。归本任务
是因为它是"分类面完整性"的一部分(§1.2),单独成 commit 不成立。

### 2.5 观测

不新增 telemetry 事件。判断帽是否够用靠现有 `tool_call_end` 时间戳事后
分析(T21 usage 体系外的话题);限流器自身静默 —— 排队不是异常,不是事件。

---

## 3. 涉及文件

### 修改

| 文件                                           | 动作                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `packages/harness/src/agents/agent.ts`         | createAgent 装配:Semaphore 构造 + withConcurrencyCap 包只读工具(§2.3) |
| `packages/harness/src/agents/types.ts`         | `CreateAgentOptions.readOnlyConcurrency?`                             |
| `packages/harness/src/tools/web-fetch/tool.ts` | 补 `readOnly: true`                                                   |
| `packages/harness/src/tools/index.ts`          | 导出 concurrency-cap                                                  |
| `tests/` 新增 `concurrency-cap.test.ts`        | §4 用例                                                               |

### 新增

| 文件                                            | 动作                                     |
| ----------------------------------------------- | ---------------------------------------- |
| `packages/harness/src/tools/concurrency-cap.ts` | `Semaphore` + `withConcurrencyCap`(§2.2) |

---

## 4. 步骤

### Step 1 · 【测试先行】Semaphore 语义(RED)

新文件 `tests/concurrency-cap.test.ts`:

- limit 2,acquire 3 次 → 第 3 个 promise pending;release 一个 → resolve;
- FIFO:3 个 waiter 按发起顺序依次拿到(用 resolve 顺序断言);
- release 双调不塌(active 计数不变,第 4 个 acquire 不被多放);
- limit 1 串行语义:两个 acquire 的进入区间不重叠(记录 enter/exit 时间戳)。

### Step 2 · 【测试先行】装配层帽(RED)

用假 LanguageModel 造一步返回 N 个只读 tool call 的场景
(参照 `tests/lead-agent-loop.test.ts` 的 mock 手法),工具用受控慢 resolve:

- `readOnlyConcurrency: 2`,一步 5 个慢只读工具(每个 resolve 挂
  `setTimeout 30ms`)→ 观测最大同时在飞数(enter/exit 计数)≤ 2;
- 5 个**全部完成**、结果按 toolCallId 无丢失(SDK Promise.all 保序返回,
  断言每个 result 都在);
- 混一步 2 只读 + 2 写工具 → 写工具**立即**开始(不等只读的帽),
  断言写工具的 enter 时间 ≈ 步开始(不受只读排队影响);
- web_fetch 有 readOnly 标志:直接断言 `createWebFetchTool(...).readOnly
=== true`。

### Step 3 · 实现(GREEN)

按 §2.2–2.4。既有 lead-agent 系列测试全量回归(装配层新增包装不能改变
事件序列 / 结果语义 —— 只许慢,不许变)。

`pnpm typecheck && pnpm test` 全绿。

### Step 4 · 摘除实验

把 `withConcurrencyCap` 从装配里摘掉(或 Semaphore limit 设 Infinity)→
Step 2 的"最大同时在飞 ≤ 2"必须变红。

---

## 5. 验收

- [x] `pnpm typecheck && pnpm test` 全绿(439 用例);新用例 RED→GREEN
      (collect 阶段即红:concurrency-cap 模块不存在),lead-agent 既有用例不破
- [x] 摘除实验:capTools 改回原样透传 → "最大同时在飞 ≤ 2"变红
      (实测 1 failed,恢复后 8/8 绿)
- [x] 用例代替手工:一步 10 个只读工具不传 readOnlyConcurrency →
      maxConcurrent 恰为 10(默认帽全放行);"混 2 只读 + 1 写"用例钉住
      写工具 enter < 50ms(只读挂 100ms —— 被帽挡住必然超过)
- [x] web_fetch 补标断言:`createWebFetchTool(...).readOnly === true`
      (tests/concurrency-cap.test.ts)

## 6. 坑

1. **包装顺序反了会把帽拖进审批弹窗**(§2.3):限流必须在审批**内层**。
   测试里若 requestApproval 是慢 mock,Step 2 的"写工具立即开始"断言会
   顺带钉住这一点 —— 写工具不过限流,但审批也不该占帽。
2. **Semaphore 不是可重入的,也别做成可重入。** 工具 execute 不会嵌套调
   自己;可重入信号量是给递归锁准备的,这里做成可重入反而让"同一步同工具
   两个调用"绕帽。
3. **release 忘在 finally 里 = 帽永久泄漏。** withConcurrencyCap 的包装体
   必须 `try { ... } finally { release(); }` —— 一个 throw 的工具把帽带崩,
   后续所有只读调用全饿死,而且表象是"agent 越跑越慢",极难归因。
4. **别用 p-limit。** 依赖树上多一个包换 50 行手写,而手写版能保证 FIFO
   语义可控(p-limit 的队列策略在迭代版本间变过)。r1 契约"依赖最小化"。
5. **帽对 subagent 的 fork 不生效是设计,不是漏。** subagent 工具没标
   readOnly → 直通。子代理自己的 agent 实例(独立 createAgent)有自己的
   帽 —— 两层帽互不感知,各管各的资源面。
6. **测试的"最大同时在飞"别用墙钟断言。** 用计数器:enter 时
   `concurrent++`,记 `maxConcurrent = max(...)`,exit 时 `concurrent--`。
   墙钟在 CI 慢机上必然 flaky。
