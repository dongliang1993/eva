# r14 · Harness 入参对齐 Claude Agent SDK

> 状态：**已细化为可施工的 spec，见 [`specs/001-harness-sdk-shape/`](../../specs/001-harness-sdk-shape/)。**
> 本文保留为决策背景；字段、顺序、任务拆分以 spec 目录为准（两者冲突时以 spec 为准）。
> 参照：[Claude Agent SDK TypeScript 参考](https://code.claude.com/docs/zh-CN/agent-sdk/typescript)、
> [权限](https://code.claude.com/docs/zh-CN/agent-sdk/permissions)、[代理循环](https://code.claude.com/docs/zh-CN/agent-sdk/agent-loop)；
> 对照项目 `.refrences/{kimi-code,deepseek-harness,cc,weave}`。

## 1. 目标

harness 的公开 API 照 Claude Agent SDK 的 `query({ prompt, options })` 形状重写，让「server 怎么用 harness」
一眼能读懂，也让熟悉 SDK 的人零成本上手。

**照抄的是入参与出参的形状，不是实现。** 循环仍是 AI SDK v7 的 `streamText`，模型仍可以是任何
provider，SQLite 仍是唯一事实源。

## 2. 现状的问题（代码实证）

| 问题 | 证据 |
|---|---|
| 输出走 4 条路，同一事实报多遍 | `yield AgentStreamEvent`、`observer`（22 种事件）、`onToolExecution`、审批回调。一次工具调用同时出现在 stream 的 `tool-call`、observer 的 `tool_call_started`、`onToolExecution` 的 `started`；server 侧 `observer-bridge.ts` 用 257 行 switch 翻译 |
| 审批是 boolean，策略两边各写一份 | `RequestApproval → Promise<boolean>`，plan review 另走 `RequestPlanReview`。bash 只读判定 harness（`with-approval.ts:50`）判一次、server（`run-approval-channel.ts:101`）再判一次；harness 判通过就不调回调，server 那条分支走不到 |
| harness 写死工具名 | `risk.ts`、`policy-key.ts`、`with-approval.ts`、`with-plan-gate.ts` 里的 `"bash"` / `"write"` / `"edit"` |
| 入口分散 | `createAgent`（12 字段）+ `stream()`（8 字段）+ `additionalTools` 旁路；`activeToolNames` / `preferredToolNames` / `context` 生产代码零调用 |
| 工具执行是 5 层洋葱 | plan gate → approval → concurrency → timing → tool，计时靠共享 `ToolTimingState` 拼回；失败靠输出以 `"Error:"` 开头判断 |

## 3. 目标 API

### 3.1 入口

```ts
// packages/harness/src/query.ts
export function query(params: {
  prompt: ModelMessage[];          // SDK 是 string | AsyncIterable；Eva 由 server 每轮给完整历史
  options: Options;
}): Query;

export interface Query extends AsyncGenerator<HarnessMessage, void> {
  interrupt(): Promise<void>;      // 等已派发的工具 drain 完再结束（现有语义）
}
```

### 3.2 Options

字段名、语义与 SDK 同名同义；只保留 Eva 今天真正用到的。

| 字段 | 类型 | 对应 SDK | 现在在哪 |
|---|---|---|---|
| `model` | `ModelBinding`（`LanguageModel` + `contextWindow` + `maxOutputTokens` + 身份） | `model: string` —— Eva 多 provider，传对象不传字符串 | `createAgent.model` + `contextPolicy` + `modelIdentity` |
| `systemPrompt` | `string \| string[]` | 同名 | `createAgent.systemPrompt` |
| `tools` | `ToolDefinition[]` | 同名（SDK 是名字列表，自定义工具走 MCP） | `createAgent.tools` + `stream.additionalTools` |
| `agents` | `Record<string, AgentDefinition>` | 同名，字段 `description` / `prompt` / `tools` / `model` / `maxTurns` 同名 | `SUBAGENT_ROLES` 写死在 harness |
| `canUseTool` | `CanUseTool` | **同名同签名** | `requestApproval` + `requestPlanReview` |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | 同名，首批只实现 `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `onToolExecution` + observer 的工具事件 + plan gate 包装 |
| `maxTurns` | `number` | 同名 | `maxSteps` |
| `abortController` | `AbortController` | 同名 | `stream.abortSignal` |
| `includePartialMessages` | `boolean` | 同名 | 现在恒开 |
| `effort` / `thinking` | 暂不做 | — | — |

**不照抄的**：`settingSources` / `cwd` / `permissionMode` / `allowedTools` / `resume` / `persistSession` /
`mcpServers` —— 这些是 Claude Code 进程的配置面。Eva 里对应的东西（工作区、always-allow、MCP、会话）
属于 server，harness 不该知道。`permissionMode` 的 `plan` 语义由 server 的 `canUseTool` 实现（见 §3.4）。

### 3.3 工具

```ts
export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I> | JSONSchema;   // 内置用 zod，MCP 透传 JSON Schema
  annotations?: {                            // 与 SDK / MCP 的 ToolAnnotations 同名
    readOnlyHint?: boolean;                  // true → 可并发；并作为 canUseTool 的默认判据之一
    destructiveHint?: boolean;
  };
  handler(input: I, extra: { toolUseID: string; signal: AbortSignal }): Promise<ToolResult>;
}

// 与 MCP CallToolResult 同形：不再靠 "Error:" 前缀判断失败
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
```

`needsApproval` 字段删除：「要不要问人」是策略，不是工具的属性 —— SDK 也没有这个字段。
MCP 工具的 `readOnlyHint` 直接映射到 `annotations`，不再单独转换。

### 3.4 权限：`canUseTool`

签名与 SDK 一致：

```ts
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; agentID?: string },
) => Promise<PermissionResult>;

export type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };
```

harness 里的评估顺序照 SDK 文档「权限如何被评估」，砍到 Eva 用得上的三步：

```text
PreToolUse hooks（可 deny） → annotations.readOnlyHint=true 直放 → canUseTool → 没配 canUseTool 则 deny
```

server 的 `canUseTool` 就是今天 `RunApprovalChannel.requestApproval` 的放行链，**整条留在 server**：

```text
plan gate 拦写 → bash 只读直放 → plan 文件写直放 → always-allow 命中 → 发 approval_request 问人
```

- `isSafeReadOnlyCommand`、`classifyToolRisk`、`buildPolicyKeys`、`matchesPlanGatePath` 从 harness 搬到 server。
  harness 里不再出现任何工具名。
- `deny.message` 作为工具结果回给模型（现在的 `[Approval Denied] …` 文案搬到 server）。
- `deny.interrupt: true` 结束本轮 —— 现在 plan review 的 `reject_and_exit` 靠 `planGateState.shouldStopTurn()` 实现，改走这里。
- **plan review 不再是平行通道。** `exit_plan_mode` 就是一个工具调用，server 的 `canUseTool` 看到它就走
  plan review UI；决策（approve / revise / reject / reject_and_exit）在 server 落库，`allow` 时用
  `updatedInput` 把决策传给工具，`deny` 时用 `message` 带上 feedback。这和 SDK 里 `ExitPlanMode`
  经由 `canUseTool` 处理的做法一致。

### 3.5 输出：`HarnessMessage`

消息名与 SDK 的 `SDKMessage` 同名，字段收敛到 Eva 用得上的：

```ts
export type HarnessMessage =
  | { type: "system"; subtype: "init"; model: string; tools: string[] }
  | { type: "stream_event"; event: StreamDelta; parent_tool_use_id: string | null }   // includePartialMessages
  | { type: "assistant"; message: AssistantModelMessage; parent_tool_use_id: string | null }
  | { type: "user"; message: ToolModelMessage; parent_tool_use_id: string | null }     // 工具结果
  | { type: "system"; subtype: "compact_boundary"; trigger: "auto"; pre_tokens: number }
  | { type: "system"; subtype: "api_retry"; attempt: number; error: string }
  | { type: "result"; subtype: "success" | "error_max_turns" | "error_during_execution";
      num_turns: number; usage: TokenUsage; duration_ms: number;
      stop_reason: string | null; terminal_reason: TerminalReason; errors?: string[] };
```

- **一条输出。** observer 的 22 种事件里，UI 与轨迹需要的都能从上面的消息推出来
  （`model_first_token` = 第一条 `stream_event`，`step_*` = 每条 `assistant` 前后，`context_compacted` =
  `compact_boundary`）。少数纯诊断字段（request snapshot、三段计时）放进对应消息的可选字段。
- **持久化不再需要单独回调。** `tool_operations` 先写 intent 的约束，用 `PreToolUse` hook 实现：
  hook 是 `await` 的，执行前一定写完。`PostToolUse` / `PostToolUseFailure` 写 result。
  这正是 SDK 里 hook 的用途，也是 kimi「durable 事件 await」的同一个思路。
- `parent_tool_use_id` 标记子代理消息（SDK 同名字段），取代现在 `subagent_update` 的信封。

### 3.6 server 侧的样子

```ts
const q = query({
  prompt: context.modelMessages,
  options: {
    model: binding,
    systemPrompt,
    tools,
    agents: SUBAGENTS,
    canUseTool: approvals.canUseTool,
    hooks: {
      PreToolUse:  [{ hooks: [toolOperations.recordIntent] }],
      PostToolUse: [{ hooks: [toolOperations.recordResult] }],
      PostToolUseFailure: [{ hooks: [toolOperations.recordFailure] }],
    },
    maxTurns: 100,
    abortController: run.controller,
    includePartialMessages: true,
  },
});
for await (const message of q) {
  recorder.record(message);          // assistant 消息投影
  trajectory.record(message);        // run_events
  for (const frame of toStreamFrames(message)) run.emit(frame);   // SSE
}
```

三个消费方读同一条流。SSE 协议（`packages/shared/src/stream-events.ts`）**不改**，`toStreamFrames`
负责翻译 —— 前端零改动。

## 4. 不变的部分

- 每一步还是 AI SDK `streamText` + `prepareStep`；上下文压缩、工具结果预算、max-output 续写不动。
- SQLite 是唯一事实源；harness 每轮从 server 拿完整历史，不持有会话。
- Coordinator 的五个阶段、终态单出口、断连不停止。
- SSE 帧格式、前端投影。
- 子代理仍是 awaited 工具（`Agent`），只是角色从写死改成 `options.agents` 传入。

## 5. 风险与取舍

| 风险 | 处理 |
|---|---|
| 测试大量直接用旧 API（`createAgent` 17 个文件、`buildTool` 16 个、`needsApproval` 10 个） | 每张卡同时改测试；**行为断言不改，只改调用形状**。卡 1–3 期间旧 API 保留为薄适配，卡 4 删除 |
| `onToolExecution` 改成 hook 后，intent 写入时机变化 | `PreToolUse` 在授权之后、执行之前触发，与现在 `withExecTiming` 的位置相同；`tool-operations.test.ts` 钉住 |
| observer 收进消息流后，`run_events` 的种类可能少几种 | 卡 3 先列出轨迹页实际用到的 kind，逐个确认能从消息推出；推不出的保留为消息上的可选字段 |
| 「照抄 SDK」被理解成「接 SDK」 | 不接。harness 依赖仍只有 `ai` + `zod`；将来真要加 Claude Agent SDK 后端，它会是同一个 `query()` 签名的第二个实现 |

## 6. 任务卡

| 卡 | 内容 | 退出条件 |
|---|---|---|
| **T55 权限** | `canUseTool` + `PermissionResult` 取代 `RequestApproval` / `RequestPlanReview`；放行链与只读/风险/policy/plan 路径判定搬到 server；plan review 并入 `canUseTool`；`deny.interrupt` 取代 `shouldStopTurn` | harness 源码里不再出现 `"bash"` / `"write"` / `"edit"` 字面量；审批、plan review、always-allow 全部测试原断言通过 |
| **T56 工具** | `ToolDefinition { annotations, handler → ToolResult }` 取代 `AgentTool` / `needsApproval` / `"Error:"` 前缀；5 层包装收成一个 `runToolCall`（hooks → 权限 → 并发位 → 执行），三段计时写在流程里 | `tool-pipeline` / `tool-timing` / `tool-abort` 原断言通过；`TOOL_ERROR_PREFIX` 删除 |
| **T57 输出** | `HarnessMessage` 取代 `AgentStreamEvent` + `observer` + `onToolExecution`；`tool_operations` 改由 `PreToolUse` / `PostToolUse` hooks 写；server 一个循环三个消费方 | SSE 帧逐字节不变（`stream-reducer` / `run-detach` 测试）；轨迹页用到的 kind 全部还在 |
| **T58 入口** | `query({ prompt, options })` 取代 `createAgent` + `stream()`；`agents` 取代写死的 `SUBAGENT_ROLES`；删除旧 API 与未使用的 `activeToolNames` / `preferredToolNames` / `context`；更新 `docs/current/` | `packages/harness/src/index.ts` 只导出 `query`、`tool`、类型；ADR 记录本轮决策 |
