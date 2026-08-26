# T50 · 工具三段计时

> 前置：T49（run-scoped observer 与事件类型）。读 `00-overview.md` §3 契约 6、7 和 §5。
> 方案出处：设计文档 §6。

## 1. 问题

现在只有一个数：`stream-part-mapper.ts:40-41` 用 `Date.now() - inFlight.startedAt`，起点是收到 `tool-call`（`:74`）、终点是收到 `tool-result`。中间夹着整条包装链 —— 装配序 `cap → approval → planGate`（`agent.ts:697-708`），执行序反过来是 `planGate → approval → cap → execute`。

所以这个数里混着审批等待、并发排队等待和真实执行。用户提供的 DSH 日志里有一次调用审批等了约 402,926 ms、真实执行 51 ms —— 合成一个「403 秒」的工具耗时，对定位性能问题毫无价值，还会让人以为工具很慢。

## 2. 改动

### 2.1 三个打点位

| 指标 | 位置 |
|---|---|
| `waiting_for_approval_ms` | `with-approval.ts:48` 调 `requestApproval` 前后 |
| `waiting_in_queue_ms` | `concurrency-cap.ts:63` 调 `limiter.acquire()` 前后 |
| `tool_exec_ms` | `build-tool.ts:99-100` 调 `definition.execute` 前后；`build-json-schema-tool.ts:44` 同 |

最内层那段**必须**在 `buildTool` / `buildJsonSchemaTool` 里统一打，不能由每个工具自己实现 —— 否则 MCP 工具、fs 工具、plan-weave 工具各写一套，第一个漏的就成了黑洞。

`build-tool.ts:99` 那行是 `Promise.race([definition.execute(...), abortFallback(signal)])`：T25 的 race 兜底。计时要包住 race 整体，abort 抢先时记的是「到被中止为止」的执行时长，并标 `aborted: true`。

### 2.2 timing state 汇聚

三个 wrapper 分处不同文件、彼此不认识，但都拿得到 `toolCallId`。新增 run-scoped 的 `ToolTimingState`（放 `packages/harness/src/tools/tool-timing.ts`），按 `toolCallId` 存三段值：

- 三个 wrapper 各自 `record(toolCallId, phase, ms)`。
- ledger 侧：每段结束时**各自独立发事件**（`approval_asked`/`approval_decided` 已经是独立事件，排队与执行各发一条阶段事件），不等汇总。
- SSE 侧：mapper 收到 `tool-result` 时 `take(toolCallId)` 取走完整快照，交给 T51 写进帧。

state 与 `agent.ts:294` 的 `clock` 是两张表，职责不同，不要合并：`clock` 管在飞集合（abort 补发要用），timing state 管分段耗时。

三层 wrapper 通过装配期注入拿到同一个 state 实例；不走 `ToolExecutionOptions`（那是 SDK 的调用元数据，塞观测进去会和 SDK 版本耦合）。

### 2.3 缺省与边界

- 无审批、无排队时对应字段为 **0**，不是 `undefined` —— `undefined` 会让「没等」和「没测」分不清。
- 被 plan gate 挡掉的调用（`agent.ts:707`，`withPlanGate` 在最外层）既不进审批也不进 execute，三段全 0 且 `tool_exec_ms = 0` 是正常结果，不报异常。
- 异常与取消也要发 completed/failed 事件，别只在成功路径上发。

## 3. 验收

- 构造一次「审批等 2 s、排队等 1 s、执行 50 ms」的调用：三个数字各自独立正确，三者之和不等于任何单一字段。
- 无审批无排队的只读工具：两个等待字段是 0，`tool_exec_ms` 与手工计时吻合。
- plan gate 挡掉的 `write`：三段全 0，无异常、无 warn。
- 工具内部抛异常：仍发 `tool_call_completed(status=error)`，`tool_exec_ms` 是到抛出为止的时长。
- abort 抢在 `execute` 之前完成：`tool_exec_ms` 有值且 payload 标 `aborted: true`。
- MCP 工具（走 `build-json-schema-tool`）与 fs 工具（走 `build-tool`）都有 `tool_exec_ms`，没有哪一类是黑洞。
