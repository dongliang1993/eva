# Implementation Plan: Harness API 对齐 Claude Agent SDK

**Spec**: [`spec.md`](./spec.md) · **Contract**: [`contracts/harness-api.ts`](./contracts/harness-api.ts) · **Tasks**: [`tasks.md`](./tasks.md)

## 1. 现状

harness 与 server 之间今天交换的东西（全部经过代码核对，2026-10-12）：

| 方向 | 通道 | 位置 |
|---|---|---|
| server → harness | `createAgent(12 字段)` + `agent.stream(8 字段)` + `additionalTools` 旁路 | `packages/harness/src/agents/{types,run-loop}.ts` |
| harness → server | ① `yield AgentStreamEvent`（给 SSE 与消息投影） | `run-loop.ts` 9 处 yield |
| harness → server | ② `observer(AgentTelemetryEvent)`，22 种 | `agents/observer.ts`；server 侧 `observer-bridge.ts` 257 行 switch + `pino-observer.ts` |
| harness → server | ③ `onToolExecution`（写 `tool_operations`） | `tools/with-exec-timing.ts` → `runs/tool-operations.ts` |
| harness ↔ server | ④ `requestApproval → boolean` + `requestPlanReview → PlanReviewDecision` | `tools/with-approval.ts`、`tools/plan-gate/tools.ts` → `runs/run-approval-channel.ts` |

工具执行链（`tools/tool-pipeline.ts`）：`withPlanGate → withApproval → withConcurrencyCap → withExecTiming → tool`，
外加 `drain` 包装；计时由三层各自写进共享的 `ToolTimingState`，`stream-part-mapper` 再 `take` 出来。

已知的问题，本次顺带消除：

- bash 只读判定在 `with-approval.ts:50` 与 `run-approval-channel.ts:101` 各判一次；前者通过就不调回调，后者那条分支走不到。
- `tool-discovery.ts` 的核心工具名单写的是 `write_file` / `edit_file`，实际工具名是 `write` / `edit` —— discovery 模式下写工具不会进首步。
- 工具成败靠输出字符串以 `"Error:"` 开头判断（`stream-part-mapper.ts:36`）。
- `AgentRunInput.activeToolNames` / `preferredToolNames` / `context` 生产代码零调用。

## 2. 目标结构

```text
packages/harness/src/
  query/                      新：公开入口与它的内部
    types.ts                  契约 contracts/harness-api.ts 的类型，原样
    query.ts                  query()：组装 → 驱动 turn 循环 → 产出 HarnessMessage
    turn.ts                   一次模型调用：streamText 一步 → assistant / stream_event
    tool-call.ts              一次工具调用：hooks → 权限 → 并发位 → execute → hooks（替代 5 层包装）
    permission.ts             evaluatePermission()：FR-004 的评估顺序，纯函数 + canUseTool
    hooks.ts                  runPreToolUse / runPostToolUse：matcher 匹配与 await
    messages.ts               HarnessMessage 构造函数（纯函数）
    subagent-tool.ts          内置 subagent 工具：读 options.agents，递归调 query()
  tools/
    tool.ts                   tool() / toolFromJsonSchema() / textResult() / errorResult() / aborted()
    fs/ memory/ web-*/ ...    各工具改成返回 ToolResult（只改返回值，不改逻辑）
    plan-gate/                只剩 state + enter/exit 工具；不再有闸门包装与 reminder
  context/                    不动
  agents/                     删除（run-loop、observer、stream-part-mapper、finish-run 的逻辑迁入 query/）
  approval/                   删除（policy-key 搬到 server）

apps/server/src/modules/runs/
  run-permissions.ts          新：canUseTool 实现（原 RunApprovalChannel 的放行链 + plan gate 闸门）
  tool-policy.ts              新：isSafeReadOnlyCommand / classifyToolRisk / buildPolicyKeys（从 harness 搬来，逻辑不改）
  harness-frames.ts           新：HarnessMessage → RunStreamEvent[]（纯函数，SSE 协议不变）
  tool-operations.ts          改：导出 toolOperationHooks(db, runId, agent) → Options["hooks"]
apps/server/src/modules/observability/
  run-trajectory.ts           新：HarnessMessage → run_events（替代 observer-bridge 的 switch）
```

## 3. 关键设计决定

每一条都已核对过代码或 AI SDK v7 源码，实现时不要重新发明。

### 3.1 工具执行仍由 AI SDK 驱动

`turn.ts` 里依旧 `streamText({ tools, stopWhen: stepCountIs(1), prepareStep })`。传给 AI SDK 的每个 tool 的
`execute` 是 `(input, { toolCallId, abortSignal }) => runToolCall(...)`，`runToolCall` 返回 `ToolResult`。

AI SDK 用 `toModelOutput` 把工具返回值转成模型看到的内容（`ai/dist/index.js` 的 `createToolModelOutput`）。
每个 tool 设置 `toModelOutput: ({ output }) => ({ type: "text", value: textOf(output) })`，
模型看到的文本与今天逐字一致；`tool-result` stream part 的 `output` 拿到的是完整 `ToolResult`，
`isError` 直接从对象上读，不再看前缀。

### 3.2 一次工具调用 = 一个函数

`tool-call.ts` 导出一个函数，按顺序写完整个生命周期，不再用包装器：

```text
signal.throwIfAborted()
PreToolUse hooks          → 任一返回 deny：结果 = deny 文案，跳过后面全部，不触发 Post hooks
evaluatePermission()      → 计时 approval_wait_ms
  deny                    → 结果 = textResult(message) 或 errorResult(message)；interrupt 时记到 turn 状态
  allow                   → input = updatedInput ?? input
readOnly ? 等并发位      → 计时 queue_wait_ms
execute(input, extra) → 计时 exec_ms；抛错兜底成 errorResult
PostToolUse / PostToolUseFailure hooks（isError 或抛错走 Failure；abort 时 is_interrupt=true）
return ToolResult
```

三段计时存在 `query()` 局部的 `Map<toolUseId, ToolTiming>` 里，`UserMessage.tool_timing` 从这里取。
`ToolTimingState` 接口与 `take()` 语义删除。

**hooks 失败的处理**：hook 抛错 = 本次工具调用失败（返回 errorResult，并走 PostToolUseFailure）。
这与今天 `onToolExecution` 写库失败会让工具失败的语义一致 —— intent 没写进去就不能执行。

### 3.3 plan gate 改成权限策略

今天的 `withPlanGate` 是一个包装器，「硬挡非 plan 路径的 write/edit 与 TaskStop/Cron*」。改造后它是 server
`canUseTool` 放行链的**第一步**，返回 `{ behavior: "deny", message: planGateDeniedMessage(planPath) }`。

这在 harness 的评估顺序里位于 `readOnlyHint` 直放之后。write / edit 不是只读工具，所以一定会走到 `canUseTool`；
`TaskStop` / `CronCreate` / `CronDelete` 在 Eva 里不存在，`HARD_BLOCKED_TOOLS` 直接删除。

plan 提醒（`reminder.ts`）改由 server 通过 `options.dynamicInstructions` 提供。

### 3.4 exit_plan_mode 并入 canUseTool

server 的 `canUseTool` 看到 `toolName === "exit_plan_mode"`：

1. 读 plan 内容、`recordRevision`、发 `plan_review_request` 帧、`askPlanReview` 等决策、发 `plan_review_resolved` 帧
   （今天 `RunApprovalChannel.requestPlanReview` + `createExitPlanModeTool` 前半段做的事，搬到一个 server 函数里）。
2. 按决策返回：

| outcome | 返回 | 模型看到（逐字同今天） |
|---|---|---|
| `approve` | `allow`，`updatedInput: { ...input, decision }` | 工具 execute 做 `store.approve` + `state.exit()` 并返回今天的文案 |
| `revise` | `deny`，`message`=今天 revise 文案 | `User rejected the plan. Feedback: …` |
| `reject` | `deny`，`isError: true`，`interrupt: true` | `Error: Plan rejected. Plan mode remains active.…` |
| `reject_and_exit` | 先 `store.reject` + `state.exit()`，再 `deny`，`isError: true`，`interrupt: true` | `Error: Plan rejected by user. Plan mode deactivated.` |
| `dismissed` | `deny`，`message`=今天 dismissed 文案 | `Plan approval dismissed. Plan mode remains active.` |

`exit_plan_mode` 的 execute 只剩「approve 分支」：有 `decision` 就落库解闸返回文案；没有 `decision`
（无 server 的测试场景）就当作直接批准。`RequestPlanReview` 类型删除。

前置校验（plan 未激活、plan 文件为空）仍在 execute 里，但 server 必须在发审批帧**之前**做同样的检查并直接 deny ——
不能为一个空 plan 弹审批卡。两处用同一个 server 函数 `planReviewPrecondition(state, store)`。

### 3.5 一条输出流，三个消费方

server 的流式阶段：

```ts
for await (const message of q) {
  recorder.record(message);                          // assistant 消息投影（AssistantMessageRecorder 改吃 HarnessMessage）
  trajectory.record(message);                        // run_events
  for (const frame of toRunStreamFrames(message)) run.emit(frame);   // SSE
}
```

`toRunStreamFrames` 的映射（必须让现有前端与 `stream-reducer` 测试零改动）：

| HarnessMessage | 帧 |
|---|---|
| `stream_event` step_start | `step-start`（`step` = `turn`；每次模型调用都发，含第一次，先于本次调用的其他帧） |
| `stream_event` text/reasoning/tool_input_* | `text-delta` / `reasoning-delta` / `tool-input-start` / `tool-input-delta` |
| `assistant`（tool-call part） | `tool-call` 帧 |
| `assistant`（text / reasoning part） | 无（增量已由 `stream_event` 发过） |
| `system/turn_complete` | 无 |
| `user` | 每个 tool-result part → `tool-result` 帧，`status` 由 `isError` 决定，计时取 `tool_timing` |
| `result` success / error_max_turns / interrupted | `finish` 帧（`finishReason` 分别为 stop / max-steps / aborted） |
| `result` error_during_execution | `error` 帧（带 `failureLayer`）+ `finish(error)` |
| `system/init` / `compact_boundary` | 无 |

**`assistant` 按内容块发，不等整次模型调用结束**（契约 `HarnessMessage` 的顺序保证）。tool-call 块一到就发
`assistant`，AI SDK 随即开始执行这个工具 —— 所以前端收到的顺序与今天相同：`tool-call` 帧先于 `approval_request` 帧。
`turn.ts` 在 AI SDK 的 `text-end` / `reasoning-end` / `tool-call` part 上产出 `assistant`。

**`includePartialMessages: false` 时**，text / reasoning 的 `assistant` 是唯一的文本来源，`toRunStreamFrames`
不需要处理这种情况（server 永远传 `true`）；但 harness 的测试要覆盖它。

### 3.6 run_events 的 26 种 kind

`run-trajectory.ts` 从消息与 hooks 推出今天的事件。对照表（实现时逐行打勾）：

| kind | 来源 |
|---|---|
| `run_started` / `routing_resolved` / `skills_selected` / `operation_abandoned` / `request_snapshot_ref` | 不变（server 自己写） |
| `turn_started` | `system/init` |
| `request_snapshot` | `system/init`（`system_prompt` + `tools` + `model`）；去重逻辑照搬 |
| `step_started` / `model_call_started` | `stream_event` step_start |
| `model_first_token` | `system/turn_complete.ttft_ms`（null 时不记） |
| `model_call_completed` / `step_completed` | `system/turn_complete`（`usage`、`duration_ms`） |
| `tool_call_started` | tool-call 块的 `assistant` |
| `approval_asked` / `approval_decided` | server `canUseTool` 内部直接写（它本来就知道） |
| `tool_call_completed` | `user` 的 tool-result parts + `tool_timing` |
| `tool_call_abandoned` | abort 时 `user` 里 `tool_timing[id].aborted` |
| `context_compacted` | `compact_boundary` |
| `loop_transition` | `compact_boundary.trigger === "overflow_retry"`，或 `result.subtype === "error_max_turns"` |
| `model_call_failed` / `context_overflow` | `result.subtype === "error_during_execution"` 的 `failure_layer` 与 `errors` |
| `assistant_message` / `turn_completed` / `run_completed` / `run_failed` | `result` |

`pino-observer.ts` 同样改成消费 `HarnessMessage`，只保留今天 10 个 case 里仍有意义的日志。

## 4. 代码风格约束（必读）

验收时**逐条**检查。参照物：`apps/server/src/modules/runs/run-coordinator.ts`（本仓最近一次按这些标准重写的文件）。

### 4.1 结构

1. **一个函数只做一件事，函数体 ≤ 40 行。** 超过就说明里面藏着一个应该有名字的步骤。
   `query()` 的主体应该能读成「组装 → for 循环 → 产出 result」，细节全在被调用的具名函数里。
2. **一个文件只有一个主题，≤ 300 行。** `run-loop.ts` 今天 574 行，拆的依据是 §2 的文件表，不是行数。
3. **编排函数里只有顺序。** 带条件分支的细节搬进被调用的函数（ADR 0003）。读 `query()` 时不应该看到任何
   `if (toolName === ...)` 或计时代码。
4. **不要包装器套娃。** 新代码不许出现「接一个 `execute`，返回一个改过的 `execute`」的形态。
   横切逻辑写成顺序调用的普通函数（§3.2 的样子）。
5. **可变状态集中在一个具名对象里**，并在旁边写清它的生命期（参照 `run-coordinator.ts` 的 `RunProgress`）。
   禁止在函数顶部堆一串 `let`。

### 4.2 类型

6. **判别联合 + 穷尽 switch。** 处理 `HarnessMessage` / `HookInput` / `PermissionResult` 的 switch 必须在
   `default` 分支写 `const unreachable: never = x; return unreachable;`（或抛错），让新增变体在编译期报错。
7. **不用 `as` 收窄业务类型。** 唯一允许的 `as` 是 AI SDK 边界（`Tool` 泛型、`ModelMessage` 内容数组）
   和 JSON 解析，每处后面写一句为什么。禁止 `as never`、`as unknown as`。
8. **`readonly` 一律加在接口字段与数组上。** 对外返回新对象，不修改入参（全局规则「不可变」）。
9. **不留未使用的字段、参数、导出。** 契约之外不加「以后可能用」的字段（ADR 0006）。

### 4.3 命名

10. 与 SDK 同名的东西用 SDK 的名字（`canUseTool`、`toolUseID`、`tool_use_id`、`parent_tool_use_id`），
    包括 snake_case 的消息字段 —— 一致性优先于本仓的驼峰习惯，契约里怎么写就怎么写。
11. 其余标识符照本仓：文件 kebab-case，函数与变量 camelCase，类型 PascalCase。
12. 函数名是动词短语，说清它做什么：`evaluatePermission`、`runToolCall`、`toRunStreamFrames`。
    不用 `handle` / `process` / `manager` / `helper` / `utils` 这类空词。

### 4.4 注释

13. **注释只写代码表达不了的东西**：为什么是这个顺序、删掉会坏什么、某个值从哪来。不复述代码。
14. **不写任务编号**（`T55`、`S27`）—— ADR 0012。编号只出现在 `specs/` 与 `docs/plans/`。
15. 删除旧代码时，旧注释里仍然成立的不变量要搬到新代码旁边（例如 `withApproval` 头注释里「为什么不用 SDK 的
    toolApproval 两轮调用」）。不成立的就删，不留「原来是这样」的考古注释。
16. 注释语言跟随所在文件：已有中文注释的文件用中文。新文件用中文。

### 4.5 错误处理

17. **工具 execute 不抛**：失败返回 `errorResult(message)`。`runToolCall` 的 try/catch 是兜底，不是约定。
18. **不吞错**：任何 `catch` 要么转成结构化结果，要么带上下文重抛，要么写一行注释说明为什么可以忽略。
    今天 `run-loop.ts:340` 的 `onError: () => {}` 保留，但补一行注释（错误已经由 stream 的 `error` part 处理）。
19. **用户可见文案逐字不变。** 模型看到的拒绝 / 错误 / plan 文案以今天的测试断言为准。

### 4.6 测试

20. 测试目录镜像源码（`tests/README.md`）：`query/*` 的测试放 `tests/harness/query/`。
21. 新函数的测试测**行为**（给什么输入、产出什么消息 / 什么副作用），不测「调用了哪个内部函数」。
22. 数据库一律真 SQLite，模型一律 `MockLanguageModelV4`（照现有测试）。
23. 每个任务的 PR 描述列出：删除了哪些测试、各自被哪个新测试覆盖。

### 4.7 禁止

- 不新增依赖。不改 `packages/shared/src/stream-events.ts`。不改数据库 schema / migration。
- 不改 `context/` 下的压缩、预算、续写逻辑（只改它们的调用处）。
- 不顺手修评审里的其他问题（重试、超时、沙箱……），哪怕看见了。发现的问题写进 PR 描述的「发现」一节。
- 不保留旧 API 的兼容层到任务之后：每个任务结束时，它负责删除的旧代码必须真的删掉。

## 5. 风险

| 风险 | 处理 |
|---|---|
| AI SDK 的 `tool-result` part 拿到的是 `ToolResult` 对象而不是字符串，下游有人按字符串用 | T2 里全仓搜 `part.output` / `toOutputText`，全部改为读 `ToolResult` |
| hooks 写库改变了 intent 的写入时机 | intent 必须在权限通过之后、execute 之前；`tool-operations.test.ts` 加一条「被拒的调用不写 intent」 |
| plan review 搬到 server 后，`plan-review-protocol.test.ts` 测的是 harness 工具 | 测试按 §3.4 的表搬到 `tests/server/runs/run-permissions.test.ts`，五个分支的文案断言逐字保留 |
| 子代理递归调 `query()`，`parent_tool_use_id` 传错导致消息串到主线 | T4 加测试：主 agent 与子代理各调一次同名工具，消息的 `parent_tool_use_id` 正确 |
| 一次改 30 个测试文件，评审困难 | 拆成 §tasks 的四个任务，每个独立可验收 |
