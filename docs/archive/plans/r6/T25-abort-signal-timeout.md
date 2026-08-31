# T25 · abortSignal 透传 + 工具超时配置

> 前置:无(与 T23/T24 无文件交集,可并行;建议在 T24 前做 —— 限流器将来
> 若要可取消,信号已在)。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §1.3、§3、§4。
> 施工图:SDK v7 原生超时链路(`timeout: { toolMs, tools }`)—— 逐行核读结论
> 已内嵌 §1.1。

**建议 1 个 commit**:`feat(harness)`。改动分三层:`build-tool.ts` 透传、
fs/web 工具接信号、`agent.ts` 配 timeout。

---

## 1. 问题实证

### 1.1 SDK 超时链路(逐行核读,`node_modules/ai/dist/index.js`)

```
streamText({ timeout: { toolMs: 30_000, tools: { bashMs: 150_000 } } })
  → getToolTimeoutMs(timeout, toolName)          // :2216
      timeout 是数字 → undefined(数字速记只覆盖模型调用侧!)
      对象 → tools[`${toolName}Ms`] ?? toolMs
  → mergeAbortSignals(abortSignal, toolTimeoutMs)  // :2717
      顶层 abortSignal + AbortSignal.timeout(ms) → AbortSignal.any([...])
  → executeToolCall → executeTool({ options: { abortSignal: toolAbortSignal } })
                                                // :3022 信号送达工具 execute
```

**关键结论:SDK 从不替你杀工具。** 它只把超时折成一个 AbortSignal 塞进
`options.abortSignal` —— 工具的 execute 检查/传递这个信号,超时才生效;
不检查,await 就永远悬着(provider-utils 的 executeTool 是纯透传,无兜底)。

### 1.2 Eva 的断点

`packages/harness/src/tools/build-tool.ts:59-63`:

```ts
// 只需把 SDK 的调用 id 挑出来传给工具;其余 options 不外泄(ToolExecutionOptions 只见 toolCallId)。
const toolCallId = options?.toolCallId ?? `auto-${crypto.randomUUID()}`;
return await definition.execute(parsed, { toolCallId });
```

`abortSignal` 在这里被丢弃。同时 `agent.ts:249` 的 `streamText({...})`
参数表里没有 `timeout` —— 就算透传了,也没有超时来源。两层都断。

### 1.3 现状各工具的自救与缺口

| 工具                                       | 自带超时                                        | 响应取消(run abort)                                                     |
| ------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------- |
| bash                                       | execFile `timeout: 120_000`(bash-tool.ts:34)    | ❌ —— `killSignal` 没接顶层 abortSignal,取消 run 后 shell 继续跑满 120s |
| web_fetch                                  | `AbortSignal.timeout`(client.ts:53)             | ❌ —— 自己造的信号,与 run 取消无关                                      |
| web_search                                 | 同上(duckduckgo-client.ts:119)                  | ❌ 同上                                                                 |
| MCP                                        | `RequestOptions.timeout` 30s(mcp-client.ts:255) | ❌ 同上                                                                 |
| read_file / grep / list_dir / edit / write | **无**                                          | **无** —— NFS/FUSE 挂载、磁盘满时永久挂起                               |

另一条已核读的路径:工具 execute 内 throw **不会**炸循环 —— SDK 捕成
tool-error part 喂回模型(`executeToolCall` 的 catch,:3036-3058)。所以
挂住的表象不是报错,是**整场 run 静默停在一步**;`cancelByRun` reject 的是
外层 promise,工具内部的 fs/shell 调用照常进行。

---

## 2. 目标设计

### 2.1 三层改动总览

| 层   | 文件                                 | 改动                                                                                                  |
| ---- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 透传 | `build-tool.ts`                      | `ToolExecutionOptions` 增 `abortSignal?: AbortSignal`;包装层原样透传                                  |
| 接线 | bash / web-fetch / web-search 客户端 | 把信号接进 execFile 选项 / fetch 的 signal(与自有超时 `AbortSignal.any` 合并)                         |
| 配置 | `agent.ts`                           | `streamText` 增 `timeout: { toolMs: 默认, tools: { bashMs: 覆盖 } }`;上限经 `CreateAgentOptions` 注入 |

### 2.2 透传层:信号是可选的,语义写死

```ts
export interface ToolExecutionOptions {
  readonly toolCallId: string;
  /**
   * 取消信号 = run 被取消 ∪ SDK 工具超时。工具应尽早检查并以
   * [Tool Error] 文本返回(进流、模型可见),而不是 throw 炸协议。
   * 可选:直接调用 execute(测试)时无信号。
   */
  readonly abortSignal?: AbortSignal;
}
```

`build-tool.ts` 包装体:`return await definition.execute(parsed, { toolCallId,
...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal }
: {}) })`。可选字段展开的写法与 agent.ts 既有风格一致。

**不改 15 个工具的签名** —— `options.abortSignal` 是新增可选字段,不接
信号的工具照常工作(它们的自有超时仍在)。接线只做给"挂住风险高"的四个:
bash、web_fetch、web_search、MCP 的 callTool(后者在 server 侧,见 §2.5)。

### 2.3 接线层

**bash**(`fs/bash-tool.ts`):execFile 选项增 `killSignal: "SIGTERM"`(已有
timeout 兜底)之外,把 options.abortSignal 接上:

```ts
// 取消时主动杀子进程 —— AbortSignal 触发即 kill,不等 execFile 自己的 timeout。
options.abortSignal?.addEventListener("abort", () => child.kill("SIGTERM"), {
  once: true,
});
```

execFile 的 promise 形态拿不到 child 句柄 —— 改用回调形态包一层,或换
`spawn` 自管。取 execFile 回调包装(改动最小):`signal` 触发 → kill →
execFile 以 `SIGTERM` signal reject → 走既有 catch 输出 `Exit: SIGTERM`,
文案补一句 canceled 标记。

**web_fetch / web_search**(client 层):fetch 的 signal 与自有超时合并 ——
`AbortSignal.any([AbortSignal.timeout(this.timeoutMs), externalSignal])`
(Node ≥ 20,engines 已满足)。externalSignal 未传时行为不变。超时/取消的
报错文案已区分(`timed out` vs 通用 failed),补 canceled 分支文案。

**记忆工具/fs 其余**:不接(§2.2 的理由 —— 无外部 IO 挂点,真挂住由
toolMs 兜底透传,虽然它们不检查信号,但 toolMs 到点后 SDK 侧 part 产出不受
阻……**注意**:这是本设计最重要的诚实点,见 §6 坑 1 —— 不检查信号的工具,
超时到了也只是"信号亮了没人看"。所以 fs 工具的执行包装在
`build-tool.ts` 里统一加一个**廉价检查**:execute 前查一次
`signal.aborted`,包一层 `race` 兜底,见下)。

### 2.4 build-tool 的统一 race 兜底

与其指望每个工具自觉,不如在包装层给所有工具一个兜底(仍然收敛在装配层,
符合 r6 契约 §3.1):

```ts
// build-tool.ts 包装体内:
const signal = options?.abortSignal;
if (signal?.aborted) return "[Tool Error] Aborted before start.";
const result = await (signal
  ? Promise.race([definition.execute(parsed, opts), abortOn(signal)])
  : definition.execute(parsed, opts));
```

`abortOn` 返回一个 signal 触发时 resolve `"[Tool Error] Timed out or
canceled."` 的 promise。**race 不取消原 promise**(它还在跑,只是结果被
丢弃 —— 术语"软取消"):fs 写已经发出去了就会写完,但 run 不再被它挂住,
模型看到明确的错误文本。真取消(kill 子进程)只给 bash(§2.3)。

选 race 而非 `AbortSignal` 全链路下传到 node:fs 的理由:node fs promise API
不支持 signal(`readFile` 的 signal 选项仅 `fs.readFile` 回调版 +
`FileHandle` 部分操作支持,覆盖不全),硬做要在每个工具里手工分支 ——
治理成本远超收益,而 race 兜底一行解决"挂住"这个主要病症。

### 2.5 配置层

`agent.ts` 的 `streamText` 增:

```ts
...(this.options.toolTimeout !== undefined
  ? { timeout: this.options.toolTimeout } : {}),
```

`CreateAgentOptions` 增(`agents/types.ts`):

```ts
/**
 * SDK TimeoutConfiguration 的工具子集:{ toolMs, tools: { bashMs } }。
 * 不传 = 不配超时(现状)。server 侧注入 { toolMs: 60_000, tools:
 * { bashMs: 150_000 } } —— bash 自带 120s,给 30s 余量。
 */
readonly toolTimeout?: { toolMs: number; tools?: Record<string, number> };
```

server(`agent-factory.ts`)注入上述默认。类型故意不复用 SDK 的
`TimeoutConfiguration` 全集(totalMs/stepMs/chunkMs 明确不做,
`00-overview.md` §2.1 #4)—— 子集类型把"能配什么"钉死在工具语义内。

MCP 的 callTool 接线:server 侧 `mcp-tools.ts` 的 execute 里把
`options.abortSignal` 传给 `client.callTool` 的 RequestOptions(协议
signal 字段,`mcp-client.ts:255` 处 `signal:` 并入)。MCP 工具经
`buildJsonSchemaTool` 构造 —— **该工厂也要同步透传**(它有独立包装体,
`build-json-schema-tool.ts:30` 现在直接 `definition.execute(input)`,
连 options 都没传 —— 顺手补上,行为向前兼容)。

---

## 3. 涉及文件

### 修改

| 文件                                                         | 动作                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `packages/harness/src/tools/build-tool.ts`                   | ToolExecutionOptions 增 abortSignal;包装体透传 + race 兜底(§2.2/2.4) |
| `packages/harness/src/tools/build-json-schema-tool.ts`       | 包装体补传 options(§2.5 末段)                                        |
| `packages/harness/src/agents/agent.ts`                       | streamText 增 timeout 条件装配                                       |
| `packages/harness/src/agents/types.ts`                       | `CreateAgentOptions.toolTimeout?`                                    |
| `packages/harness/src/tools/fs/bash-tool.ts`                 | signal → kill 子进程(§2.3)                                           |
| `packages/harness/src/tools/web-fetch/client.ts`             | fetch signal 合并                                                    |
| `packages/harness/src/tools/web-search/duckduckgo-client.ts` | 同上                                                                 |
| `apps/server/src/services/mcp/mcp-client.ts`                 | callTool 增 signal 参数                                              |
| `apps/server/src/services/mcp/mcp-tools.ts`                  | execute 里传 signal                                                  |
| `apps/server/src/services/agent-factory.ts`                  | 注入默认 toolTimeout                                                 |
| `tests/` 新增/扩充                                           | §4                                                                   |

### 新增

无(全部在既有文件收敛)。

---

## 4. 步骤

### Step 1 · 【测试先行】透传 + race 兜底(RED)

`tests/`(扩充 build-tool 相关既有测试文件,无则新建 `tool-abort.test.ts`):

- 假工具 execute 永不 resolve(挂起的 promise)→ 传入已 abort 的 signal 的
  options 调 buildTool 产物 → 返回 `[Tool Error]`(race 兜底生效);
- execute 开始后才 abort → 同样在 abort 时点附近返回错误文本(用受控
  手动 resolve 的 Deferred);
- 无 signal → 行为与现状完全一致(挂起就挂起 —— 该用例断言"不炸、不返回",
  用 `expect(...).rejects`/超时断言手法,或直接不测悬挂、只测正常路径回归);
- execute throw 的既有行为不变(`[Tool Error]` 前缀,既有用例回归)。

### Step 2 · 【测试先行】bash 取消(RED)

`tests/fs-tools.test.ts` 扩充:起一个 `sleep 30` 的 bash 调用,10ms 后
abort → execute 在远小于 30s 内返回(断言 < 2s),文案含 SIGTERM/取消
标记;不 abort → 照常跑完(sleep 0.1 级别的快速用例)。

### Step 3 · 【测试先行】streamText timeout 配置(RED)

假 LanguageModel(参照 `tests/lead-agent-loop.test.ts`)返回一个调用
"挂死工具"的 tool call;`createAgent({ toolTimeout: { toolMs: 100 } })` →
run 在 ~100ms 后收到该工具的 `[Tool Error]` 结果、**循环继续**(模型收到
错误文本后正常收尾,断言 finish 事件存在)。

### Step 4 · 实现(GREEN)

按 §2 逐层落。web/web-search/MCP 的 signal 合并各补一条单元用例
(外部 signal abort → fetch 以 AbortError reject → 文案含 canceled)。

`pnpm typecheck && pnpm test` 全绿。

---

## 5. 验收

- [x] `pnpm typecheck && pnpm test` 全绿(431 用例);新用例 RED→GREEN;
      build-tool 既有行为(throw → `[Tool Error]`、auto- id 兜底)不破
- [x] 组杀用例代替手工 ps:`sleep 30 && echo` 复合命令中途 abort →
      进程表无残留(摘除实验验证过:改回只杀 pid 本体,该用例变红)。
      单命令(`sleep 300`)场景 bash 对 `-c` 末尾命令做 exec 优化,kill
      child 即 kill 命令本体,天然覆盖
- [x] toolTimeout 配置用例:挂死工具 + `{ toolMs: 100 }` → `[Tool Error]`
      收口、循环继续到 finish(stop);不配 toolTimeout → 500ms 内无任何
      finish/tool-result(回归边界,harness 不默认开启)
- [x] MCP 工具经 buildJsonSchemaTool 也能拿到 toolCallId
      (tests/json-schema-tool.test.ts 回显 options 断言)

## 6. 坑

1. **race 是软取消,写操作不会被拉回。** `write` 的 race 输了,fs.writeFile
   仍在后台完成 —— 磁盘上**有**那个文件,但模型被告知失败。语义后果:
   模型重试 → 覆盖写,终态一致;append 模式 → 可能双写一行。接受理由:
   硬取消 fs 写在 Node API 层做不到(§2.4),而"run 被挂死"的代价 >
   "取消后多一行"的代价。**别**在文案里说"已回滚" —— 说"canceled,
   may or may not have completed"。
2. **AbortSignal.any 需要 Node ≥ 20.3。** dev 机已验证(v22.22.0,见坑
   11);desktop 打包产物发版前需在 Electron 内置 Node 里再验一次。
3. **bash 的 kill 用 SIGTERM,别用 SIGKILL。** SIGKILL 跳过子进程清理
   (trap/临时文件),而 `-lc` 登录 shell 可能挂了子子进程 —— SIGTERM 后
   2s 仍未退再补 SIGKILL(两段式)。**也别接 SIGKILL 到 signal 直接** ——
   立即 KILL 丢掉 shell 的输出缓冲,错误文案里 stdout/stderr 全空,排查
   变盲。
4. **execFile 的 detached 不生效 —— 必须换 spawn(macOS 实测)。** bash
   收到 SIGTERM 不会转发给子孙进程(`sleep 30 && echo x` 里 sleep 变
   孤儿);trap 也救不了(bash 等前台子进程期间推迟 trap 执行,实测
   trap 不触发)。进程组杀是唯一可靠路径,但 `execFile` 传 `detached:
true` 后 pgid 仍挂在父进程组上(实测 pgid=父 pgid,组杀 ESRCH),
   **`spawn` 的 detached 才真正自成进程组**(pgid=pid)。落地版因此把
   execFile 换成了 spawn 回调包装,`kill(-pid)` 组杀 + 进程表无残留的
   回归用例钉死(摘除实验:改回只杀 pid 本体,用例变红)。附带收益:
   spawn 形态下输出缓冲自管,顺手加了 idle 看护(静默超时)替代 execFile
   的 maxBuffer 语义。
5. **addEventListener 记得 `{ once: true }` + 工具返回后 removeEventListener。**
   signal 是 run 级复用的 —— 同一 run 后续工具调用共用同一个顶层
   AbortSignal;不清理监听器 = 监听器随 run 泄漏累积(Node 的
   AbortSignal 默认 maxListeners 警告在 20 个 run 后开始刷屏)。
6. **buildJsonSchemaTool 补传 options 是行为变更,藏在"顺手"里最危险。**
   此前 MCP 工具的 execute 拿不到 options(连 toolCallId 都没有)——
   透传后,任何依赖"第二个参数为 undefined"的既有 MCP 工具代码路径都会
   走进新分支。改完跑全量 MCP 测试(`tests/` 里 mcp 系)确认无回归。
7. **别把 toolMs 默认值写进 harness 的默认参数。** 不传 toolTimeout =
   现状(无超时)—— 默认值由 server 的 agent-factory 注入。harness 的
   最小使用者(测试、memory-runtime 的轻量 agent)不该被强加一个 60s
   的隐形行为(r5 T18 repairModel 同款边界判断:可选能力不默认开启)。
8. **AbortSignal.any 的运行时验证已做。** dev 机 Node v22.22.0,
   `typeof AbortSignal.any === "function"`;AGENTS.md 运行要求里写明
   Node ≥ 20.3(desktop 打包的 server 走 Electron 内置 Node,发版前需
   在打包产物里再验一次)。
