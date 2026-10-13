# ADR 0013: Harness API 对齐 Claude Agent SDK 的接口形状

日期：2026-10-13
状态：已接受（spec `001-harness-sdk-shape`，归档于 `docs/archive/plans/r14/`）

## 决策

`packages/harness` 的公开接口照 Claude Agent SDK 的形状重写：

- 唯一运行入口 `query({ prompt, options })`，返回 `AsyncGenerator<HarnessMessage, void>`
  （带 `interrupt()`）。`createAgent` / `Agent.stream()` / `Agent.invoke()` 删除。
- 授权唯一入口 `options.canUseTool`，返回 `PermissionResult`（allow + updatedInput /
  deny + message + interrupt + isError）。`RequestApproval` / `RequestPlanReview` /
  `needsApproval` / 五层工具包装器删除。
- 输出唯一一条 `HarnessMessage` 流（type + subtype 判别）。`AgentObserver` /
  `AgentTelemetryEvent` / `onToolExecution` 删除；`tool_operations` 台账改由
  server 注册的 PreToolUse / PostToolUse / PostToolUseFailure hooks 写。
- 子代理角色经 `options.agents` 传入（harness 内置 `subagent` 工具递归调 `query()`，
  消息带 `parent_tool_use_id`）。server 侧另有 `SubagentRunner`（同样的 query()，
  加消息落库与 SSE 帧）。

## 为什么

改造前 server 与 harness 之间有 4 条输出通道（`yield AgentStreamEvent`、observer 22 种事件、
`onToolExecution`、审批回调）、2 种审批协议、5 层工具包装。同一件事在多处各报一遍：
一次工具调用会在 wrapper、mapper、observer、`tool_operations` 里各留一痕。Claude Agent SDK
在同样的层上已经交过这份答卷：一个入口、一个授权回调、一条消息流、hooks 承载副作用。
照抄接口形状（不是实现）能把这些结构性重复一次收掉。

## 放弃了什么（SDK 的哪些字段刻意不照抄）

- **`prompt: string | AsyncIterable<SDKUserMessage>`** → `ModelMessage[]`。Eva 的会话在
  SQLite，server 每轮给出完整历史；Claude Code 自己持有会话才需要 AsyncIterable。
- **`model: string`** → `ModelBinding` 对象。Eva 多 provider，模型的身份、窗口、输出上限
  要一起给，上下文压缩阈值从它们推导。
- **SDK 把用量挂在每条 assistant 消息上** → 单独的 `system/turn_complete`。Eva 按内容块
  拆 assistant 消息（工具不等整次调用结束就开始执行），一次调用的用量与耗时只能在
  调用结束时给出。
- **SDK 的 stream_event 是 Anthropic 原始事件** → provider 无关的 `StreamDelta`。Eva 的
  模型可以是任意 provider。
- **SDK 这个位置叫 `handler`** → `execute`。SDK 是位置参数摊平，名字只是占位；Eva 是
  对象字段，直接叫 `execute`，与 AI SDK 的 `Tool.execute` 同名对齐。
- **SDK 让非只读工具串行执行** → 写工具不排队。Eva 的正确性由 workspace 写串行锁
  （`withWorkspaceWrite`）保证，本次不改这个行为。
- **SDK 的 30+ 种 hooks** → 只实现 PreToolUse / PostToolUse / PostToolUseFailure。
  SSE 协议（`stream-events.ts`）、数据库 schema、`context/` 压缩逻辑都在 out of scope。

## 什么情况下推翻

- 需要流式用量（每条 assistant 带实时 token 计数）时：`turn_complete` 的形状要重谈
  （SDK 的做法会回来）。
- 引入 Anthropic 原生流事件透传（prompt cache 命中率等）时：`StreamDelta` 要加
  provider 私有通道。
- hooks 需要覆盖更多生命周期（Stop、SessionStart…）时：HookEvent 联合直接扩，
  `HookJSONOutput` 按 SDK 补对应分支。
- Eva 若把会话移出 SQLite、由 harness 持有：`prompt` 回到 SDK 的 AsyncIterable 形状。
