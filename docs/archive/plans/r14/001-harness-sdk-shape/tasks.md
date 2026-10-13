# Tasks: Harness API 对齐 Claude Agent SDK

**Spec**: [`spec.md`](./spec.md) · **Plan**: [`plan.md`](./plan.md) · **Contract**: [`contracts/harness-api.ts`](./contracts/harness-api.ts)

## 怎么用这份文档

- 四个任务**严格按顺序**做，每个任务一个 PR（或一个 commit），完成后交给验收人，验收通过再开下一个。
  后一个任务建立在前一个的代码上，不能并行。
- 每个任务开头的「交付物」是验收人对照的清单；「步骤」是建议顺序，可以调整，但交付物一条不能少。
- `[P]` 标记的步骤之间没有依赖，可以并行写。
- 每个任务结束时必须满足**通用退出条件**：

```bash
pnpm typecheck && pnpm lint:arch && pnpm test      # 全绿
pnpm web:build                                      # 碰了 apps/web 或 packages/shared 时
grep -rnE "\bT5[5-8]\b|\bS2[0-9]\b" packages apps   # 代码与注释里零任务编号
```

- 写代码前读完 [`plan.md` §4 代码风格约束](./plan.md#4-代码风格约束必读)。验收时逐条检查，不符合就退回。
- PR 描述必须包含三节：**改了什么**、**删了哪些测试 / 断言及替代**、**发现**（看见但按约束没修的问题）。

## 依赖图

```text
T1 工具形状 ──▶ T2 权限 ──▶ T3 输出 ──▶ T4 入口与收尾
```

T1 先做是因为后三个任务都要用 `ToolResult` 与 `ToolDefinition`；T2 在 T3 之前，是因为 T3 要删的
`onToolExecution` 依赖 T2 建好的「一次工具调用 = 一个函数」。

---

## T1 · 工具形状：`ToolDefinition` + `ToolResult`

**目标**：所有工具改用契约里的 `ToolDefinition`，返回 `ToolResult`；工具成败不再靠 `"Error:"` 前缀。
这一步**不动**权限、输出、入口 —— `createAgent` / `stream()` / observer / 审批照旧工作。

### 交付物

- [ ] `packages/harness/src/query/types.ts`：放入契约中**工具相关**的类型（`ToolDefinition`、`ToolAnnotations`、
      `ToolExtra`、`ToolResult`、`JsonSchemaInput`）。其余类型留到后续任务再加，不提前放。
- [ ] `packages/harness/src/tools/tool.ts`：
  - `tool(definition)`：构造 zod 输入的 `ToolDefinition`，execute 收到的 input 已经过 `schema.parse`（应用 `.default()`）
  - `toolFromJsonSchema(definition)`：MCP 用，inputSchema 原样
  - `textResult(text)` / `errorResult(text)` / `aborted()`：构造 `ToolResult` 的三个函数，全仓唯一的构造入口
  - `textOf(result)`：把 `ToolResult.content` 拼成模型看到的字符串
- [ ] 全部内置工具（`fs/*`、`memory/*`、`web-fetch`、`web-search`、`tool-search`、`plan-gate/tools.ts`、
      `skills/read-skill-tool.ts`、`subagents/subagent-tool.ts`）改用 `tool()`：
  - `readOnly: true` → `annotations: { readOnlyHint: true }`
  - `needsApproval: true` **暂时保留**为 `ToolDefinition` 外的过渡字段（T2 删除）——
    做法：在 `tool-pipeline.ts` 的入参类型上加一个 `needsApproval?: boolean` 的附加形状，不污染契约类型
  - 返回值：成功 `textResult(...)`，失败 `errorResult(...)`，取消 `aborted()`；**文案逐字不变**
- [ ] AI SDK 适配：传给 `streamText` 的 tool 用 `toModelOutput: ({ output }) => ({ type: "text", value: textOf(output) })`
      （plan §3.1）。模型看到的文本与改造前逐字一致。
- [ ] `stream-part-mapper.ts`：`status` 从 `ToolResult.isError` 读；`output` 字段仍输出 `textOf(result)` 字符串
      （SSE 帧不变）。
- [ ] MCP：`apps/server/src/modules/mcp/mcp-tools.ts` 改用 `toolFromJsonSchema`；`readOnlyHint` 直接进 `annotations`。
- [ ] `tool-discovery.ts` 的 `CORE_TOOL_NAMES`：`write_file` / `edit_file` 改为 `write` / `edit`（plan §1 的已知问题）。
      补一条测试：discovery 模式首步的 active 工具包含 `write` 与 `edit`。
- [ ] 删除：`AgentTool`、`buildTool`、`buildJsonSchemaTool`、`ToolDefinition`（旧）、`TOOL_ERROR_PREFIX`、
      `toToolErrorOutput`、`TOOL_CALL_ABORTED_OUTPUT`（由 `aborted()` 取代，文案不变）、`toOutputText`、`readToolStatus`。

### 步骤

1. 写 `query/types.ts` 的工具类型与 `tools/tool.ts`，配测试 `tests/harness/tools/tool.test.ts`：
   schema 默认值生效、execute 抛错被 `tool()` 兜成 `errorResult`、abort 时返回 `aborted()`。
2. `[P]` 改 `fs/*` 七个工具。
3. `[P]` 改 `memory/*`、`web-*`、`tool-search`、`read-skill`、`subagent-tool`。
4. `[P]` 改 `plan-gate/tools.ts`（只改返回值形状，五个 outcome 分支的文案不动 —— 分支逻辑 T2 才搬）。
5. 改 `tool-pipeline` 与各包装器的类型签名，让它们接收 / 返回 `ToolResult`（**包装器本身 T2 删除**，这里只改类型）。
6. 改 `stream-part-mapper`、`finish-run`、MCP。
7. 改测试：`buildTool(...)` → `tool(...)`；`execute` 返回值断言从字符串改成 `textOf(result)` 或 `result.isError`。
   **文案断言保持逐字**。

### 本任务专属验收

- `grep -rn "TOOL_ERROR_PREFIX\|startsWith(\"Error:\")\|buildTool\|buildJsonSchemaTool\|AgentTool\b" packages apps` 零命中
  （测试里的 `"Error:"` 文案断言除外）。
- 每个工具的 execute 里没有 `throw`（取消信号的 `throwIfAborted` 除外，且它被 `tool()` 兜住）。

---

## T2 · 权限：`canUseTool` + 一次工具调用一个函数

**目标**：授权只有 `options.canUseTool` 一个入口；五层包装收成 `runToolCall`；放行链与工具名判断全部搬到 server。

### 交付物

- [ ] `query/types.ts` 追加：`CanUseTool`、`PermissionResult`、`HookEvent`、`HookCallbackMatcher`、`HookCallback`、
      `HookInput`、`HookJSONOutput`（契约原样）。
- [ ] `query/permission.ts`：`evaluatePermission(tool, input, ctx)`，实现 FR-004 的四步顺序，返回 `PermissionResult`。
      纯逻辑 + 一次 `canUseTool` 调用，不计时、不写日志。
- [ ] `query/hooks.ts`：`runPreToolUse` / `runPostToolUse` / `runPostToolUseFailure`。matcher 是工具名正则；按注册顺序
      依次 await；任一 PreToolUse 返回 deny 即停。
- [ ] `query/tool-call.ts`：`runToolCall(call, ctx): Promise<ToolResult>`，严格按 plan §3.2 的顺序。三段计时写进
      调用方传入的 `Map<string, ToolTiming>`。
- [ ] harness 的 run-loop 改用 `runToolCall`；`createAgent` 的 `requestApproval` 参数替换为 `canUseTool`，并新增
      `hooks` 参数（**入口形状 T4 才改**，这里只换这两个字段）。`deny.interrupt` 结束本轮（plan §3.4）。
- [ ] server `apps/server/src/modules/runs/tool-policy.ts`：从 harness 原样搬入 `isSafeReadOnlyCommand`、
      `classifyToolRisk`、`buildPolicyKeys`、`matchesPlanGatePath`、`planGateDeniedMessage`、`APPROVAL_DENIED_PREFIX`。
      **逻辑一字不改**（只读白名单的漏洞是评审里的另一项，不在本次范围）。
- [ ] server `apps/server/src/modules/runs/run-permissions.ts`：取代 `run-approval-channel.ts`，导出
      `createRunPermissions(deps) → { canUseTool, lookupApprovalDecision, lookupPlanReviewDecision }`。
      放行链顺序（注释写清每一级为什么在这个位置，照搬今天的注释）：
      1. plan gate 拦写（原 `withPlanGate`）
      2. `exit_plan_mode` → plan review（plan §3.4 的表）
      3. bash 只读直放
      4. plan 文件写直放
      5. always-allow 命中
      6. 发 `approval_request` → 等人 → 发 `approval_resolved`
      拒绝时 `message` 用今天 `withApproval` 的 `[Approval Denied] …` 文案。
      `approval_asked` / `approval_decided` 两种 `run_events` 由这里直接写（plan §3.6）。
- [ ] `exit_plan_mode` 的 execute 只剩 approve 分支（plan §3.4）；前置校验抽成 server 的 `planReviewPrecondition`，
      execute 与 `canUseTool` 共用。
- [ ] plan 提醒：`createAgent` 新增 `dynamicInstructions` 参数（契约字段），server 用它注入今天 `reminder.ts` 的文案。
- [ ] 删除：`with-approval.ts`、`with-plan-gate.ts`、`concurrency-cap.ts` 的 `withConcurrencyCap`（`Semaphore` 保留，
      搬进 `tool-call.ts` 或同目录）、`with-exec-timing.ts`、`tool-timing.ts`、`tool-pipeline.ts`、`risk.ts`、
      `safe-readonly.ts`、`approval/policy-key.ts`、`plan-gate/reminder.ts`、`RequestApproval`、`RequestPlanReview`、
      `ToolApprovalRequest`、`PlanGateState.shouldStopTurn/requestStopTurn`、`needsApproval`（T1 的过渡字段）、
      `run-approval-channel.ts`。

### 步骤

1. 写 `permission.ts` + `hooks.ts` + 测试（`tests/harness/query/permission.test.ts`、`hooks.test.ts`）：
   评估顺序、无 canUseTool 时 deny、hook deny 优先、matcher 匹配、`updatedInput` 生效。
2. 写 `tool-call.ts` + 测试：把 `tool-timing.test.ts`、`tool-abort.test.ts`、`concurrency-cap.test.ts`
   （并发相关的用例）的**行为断言**搬过来，改成驱动 `runToolCall`。
3. 接进 run-loop，删包装器，`tool-pipeline.test.ts` 的用例并入步骤 2 的测试。
4. `[P]` server：`tool-policy.ts` 搬家（测试 `safe-readonly`、`tool-risk`、`policy-key` 跟着搬到 `tests/server/runs/`，
   断言不改）。
5. `[P]` server：`run-permissions.ts` + plan review 合并；`plan-review-protocol.test.ts` 与 `plan-review-stop-turn.test.ts`
   搬到 `tests/server/runs/run-permissions.test.ts`，五个分支的文案断言逐字保留，`shouldStopTurn` 断言改为
   「本轮在这一步后结束」。
6. 子代理：`SubagentRunner` 传 `canUseTool`（同一个实例，`agentID` = taskId）。

### 本任务专属验收

- `grep -rnE '"(bash|write|edit|exit_plan_mode|enter_plan_mode)"' packages/harness/src` 只命中各工具的 `name:` 行。
- `grep -rn "needsApproval\|RequestApproval\|RequestPlanReview\|shouldStopTurn\|withApproval\|withPlanGate" packages apps tests` 零命中。
- 新增测试：被 plan gate 拒绝的写调用，三段计时全 0（今天 `tool-timing.test.ts` 的同名用例）。
- 新增测试：`deny` 的调用不触发 PostToolUse hooks，`PreToolUse` 之后、execute 之前的 abort 走 PostToolUseFailure 且 `is_interrupt=true`。

---

## T3 · 输出：一条 `HarnessMessage` 流

**目标**：`yield AgentStreamEvent` + `observer` + `onToolExecution` 三条输出合成一条 `HarnessMessage` 流；
`tool_operations` 改由 hooks 写；server 一个循环、三个消费方。

### 交付物

- [ ] `query/types.ts` 追加全部输出类型（`HarnessMessage` 及各成员、`StreamDelta`、`ToolTiming`、`TokenUsage`）。
- [ ] `query/messages.ts`：每种消息一个构造函数（纯函数）。
- [ ] `query/turn.ts`：一次模型调用。消费 AI SDK 的 stream part，按契约的顺序保证产出 `stream_event` /
      `assistant`（按内容块，plan §3.5）/ `system/turn_complete`；上下文压缩时产出 `compact_boundary`。
      text 合并逻辑（`coalesce-stream.ts`）搬到这里只作用于 `stream_event`。
- [ ] run-loop 的输出改为 `HarnessMessage`；`createAgent().stream()` 返回 `AsyncIterable<HarnessMessage>`。
      `invoke()` 删除（今天只有测试在用，改成「消费流取 result」的测试辅助函数）。
- [ ] server `apps/server/src/modules/runs/harness-frames.ts`：`toRunStreamFrames(message): readonly RunStreamEvent[]`，
      plan §3.5 的映射表。纯函数，穷尽 switch。
- [ ] server `apps/server/src/modules/observability/run-trajectory.ts`：`createRunTrajectory(recorder) → { record(message) }`，
      plan §3.6 的对照表逐行实现；`request_snapshot` 去重照搬 `observer-bridge.ts`。
- [ ] `AssistantMessageRecorder` 与 `SubagentRecorder` 改吃 `HarnessMessage`（内部仍用 `UiMessageBuilder`，喂它
      `toRunStreamFrames` 的结果即可 —— 不要写第二套投影）。
- [ ] `pino-observer.ts` 改成消费 `HarnessMessage`。
- [ ] `tool-operations.ts`：导出 `toolOperationHooks(db, runId, agent): Options["hooks"]`，intent 在 PreToolUse 写，
      result 在 PostToolUse / PostToolUseFailure 写。`listToolExecutions` / `interruptToolExecutions` 不动。
- [ ] `Coordinator` 的流式阶段改成 plan §3.5 的三消费方循环；`SubagentRunner` 同理。
- [ ] 删除：`agents/observer.ts`（`AgentObserver`、`AgentTelemetryEvent` 及全部事件类型）、`stream-part-mapper.ts`、
      `finish-run.ts`、`coalesce-stream.ts`（逻辑已迁入 turn.ts）、`observer-bridge.ts`（或缩到 SC-002 的 80 行内，
      只剩 request snapshot 去重）、`ToolExecutionEvent`、`onToolExecution`、`AgentToolCallResult`、`AgentRunResult`、
      `AgentStreamEvent`。`RunAgentStreamEvent` 仍在 shared 里（它是 SSE 协议），harness 不再导出它的别名。

### 步骤

1. 先写 `harness-frames.ts` 与它的测试：给定消息序列，产出的帧序列与改造前**逐帧相同**。用 `run-lifecycle`、
   `run-detach`、`subagent-result` 测试里录到的真实帧做基准（先在改造前跑一遍、把帧序列存成测试数据）。
2. 写 `messages.ts` + `turn.ts` + 测试（`tests/harness/query/turn.test.ts`）：顺序保证、按块发 assistant、
   `step_start` 先于一切、`includePartialMessages` 两种取值。
3. 接进 run-loop，删 observer / mapper / finish-run。
4. `[P]` `run-trajectory.ts` + 测试：轨迹页 26 种 kind 逐个有用例，payload 字段与改造前一致
   （`trajectory-api.test.ts`、`run-observability.test.ts`、`run-events-ledger.test.ts` 的断言不改）。
5. `[P]` `toolOperationHooks` + 测试：`tool-operations.test.ts` 原断言保留；新增「被拒的调用不写 intent」。
6. Coordinator / SubagentRunner / 两个 Recorder 接线。

### 本任务专属验收

- `grep -rn "AgentObserver\|AgentTelemetryEvent\|onToolExecution\|observer:" packages apps` 零命中（测试数据文件除外）。
- `tests/web/streaming/stream-reducer.test.ts` 与 `tests/server/runs/run-detach.test.ts` 不改一行仍然通过。
- 验收人会在真实对话里比对：工具卡片的「入参流式 → 等审批 → 执行中 → 完成」状态变化与改造前一致。

---

## T4 · 入口：`query({ prompt, options })` 与收尾

**目标**：`createAgent` + `stream()` 换成 `query()`；子代理角色走 `options.agents`；删除全部旧 API；文档更新。

### 交付物

- [ ] `query/types.ts` 补齐：`Options`、`ModelBinding`、`AgentDefinition`、`Query`（契约原样，至此契约全部落地）。
- [ ] `query/query.ts`：`query({ prompt, options }): Query`。主体只有顺序（plan §4.1 第 1 条）：
      校验工具名唯一 → 产出 `system/init` → turn 循环 → 产出 `result`。`interrupt()` 等价 `abortController.abort()`
      再等迭代结束。
- [ ] `query/subagent-tool.ts`：内置 `subagent` 工具，读 `options.agents`，用递归 `query()` 跑子代理，子代理的消息
      带 `parent_tool_use_id`。`options.agents` 为空时不注册这个工具。
      server 侧 `SubagentRunner` 只剩「建 task 行 + 录子代理消息 + 结算」；角色定义从 harness 的 `SUBAGENT_ROLES`
      搬到 server（`apps/server/src/modules/subagents/roles.ts`），`missingRoleTools` 的早爆检查一并搬过去。
- [ ] `AgentFactory.build` 返回 `Options`（不再返回 `Agent`）；`Coordinator` 调 `query({ prompt, options })`。
      `contextPolicy` / `modelIdentity` / `callSettings` 并进 `ModelBinding` 与 `callSettings`；
      `toolTimeout` / `readOnlyConcurrency` 并进 `limits`。
- [ ] `packages/harness/src/index.ts`：只导出 SC-001 列出的东西。`lint:arch` 的 `harness-root-explicit-exports` 规则保持通过。
- [ ] 删除：`agents/` 整个目录、`createAgent`、`Agent`、`AgentRunInput`、`CreateAgentOptions`、`activeToolNames`、
      `preferredToolNames`、`context`（`AgentRunInput` 的）、`SUBAGENT_ROLES`、`filterToolsForRole`、`missingRoleTools`、
      `SUBAGENT_MAX_STEPS`（默认值进 `AgentDefinition.maxTurns` 的文档）。
- [ ] 文档：
  - `docs/current/architecture.md` §3 Harness、`docs/current/run-lifecycle.md` §1 与 §3、`AGENTS.md` 的 Harness 一节，
    改成 `query()` 的形状
  - 新 ADR `docs/adr/0013-harness-api-mirrors-agent-sdk.md`：决策、为什么、放弃了什么（SDK 的哪些字段刻意不照抄）、
    什么情况下推翻。ADR 0003 / 0006 / 0010 里引用旧 API 的地方补一行指向 0013。
  - 本 spec 目录与 `docs/plans/r14-harness-sdk-shape.md` 移到 `docs/archive/plans/r14/`。

### 步骤

1. 写 `query.ts` + 测试（`tests/harness/query/query.test.ts`）：把 `lead-agent-loop`、`lead-agent-abort`、
   `runtime-contract`、`tool-safety-net`、`duration-migration` 的行为断言搬过来，改成驱动 `query()`。
2. 写 `subagent-tool.ts` + 测试（主 / 子同名工具的 `parent_tool_use_id`、子代理失败经工具结果回到主线）。
3. server 接线；`agent-factory.test.ts` 改成断言 `Options` 的内容。
4. 删除旧 API，改剩下的测试。
5. 文档与 ADR。

### 本任务专属验收（同时是整个 feature 的验收）

- spec 的 SC-001 ~ SC-004 全部满足。
- `packages/harness/src` 下没有文件超过 300 行，没有函数体超过 40 行（验收人用脚本量）。
- 验收人执行 SC-005 的真实对话清单。
