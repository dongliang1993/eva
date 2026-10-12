# Feature Specification: Harness API 对齐 Claude Agent SDK

**Feature Branch**: `001-harness-sdk-shape`
**Created**: 2026-10-12
**Status**: Ready for implementation
**Input**: 「harness 层直接参照 Claude Agent SDK 的入参形式调整」

> 读这份文档的人是**实现者**。动手前按顺序读完：本文 → [`plan.md`](./plan.md) →
> [`contracts/harness-api.ts`](./contracts/harness-api.ts) → [`tasks.md`](./tasks.md) → 仓库根 `AGENTS.md`。
> 任何一处和代码现状冲突，以代码为准并在 PR 描述里写明。

## 背景

`packages/harness` 与 `apps/server` 之间现在有 4 条输出通道、2 种审批协议、5 层工具包装，同一件事在多处各报一遍
（证据见 [`plan.md` §1](./plan.md#1-现状)）。Claude Agent SDK 的 `query({ prompt, options })` 在这一层的设计
已经把这些问题解决了：一个入口、一个授权回调、一条消息流、用 hooks 承载副作用。

**照抄的是接口形状，不是实现。** 循环仍是 AI SDK v7 的 `streamText`，模型仍可以是任意 provider，
SQLite 仍是唯一事实源。不引入 `@anthropic-ai/claude-agent-sdk` 依赖。

## User Scenarios

这是一次内部重构，「用户」是读写 server 代码的开发者。终端用户可见行为必须**完全不变**。

### Story 1 — 读一次 run 只看一处（P1）

开发者打开 `run-coordinator.ts`，看到一次 `query({ prompt, options })` 调用和一个 `for await` 循环，
就能知道 agent 拿到了什么、产出了什么，不需要再去追 observer、onToolExecution、审批回调分别在哪接线。

**验收**：
1. **Given** server 发起一次 run，**When** 读 `Coordinator` 的流式阶段，**Then** harness 的全部输入都在一个
   `options` 对象字面量里，全部输出都来自同一个 `for await` 循环。
2. **Given** 任意一次工具调用，**When** 追踪它在 server 侧留下的记录（SSE 帧、`tool_operations` 行、
   `run_events` 行、assistant 消息），**Then** 都能追到同一条 `HarnessMessage` 或同一个 hook 调用。

### Story 2 — 授权策略只在一个地方（P1）

开发者要改「哪些命令免审批」，只需要改 server 的一个函数，harness 里不存在任何工具名判断。

**验收**：
1. **Given** harness 源码，**When** `grep -rnE '"(bash|write|edit|exit_plan_mode)"' packages/harness/src`，
   **Then** 只命中工具自己的 `name:` 定义行，没有任何 `if`/`switch`/`Set` 判断。
2. **Given** 一个只读 bash 命令，**When** agent 调用它，**Then** server 的 `canUseTool` 返回 allow 并落一条
   `reason="readonly-safe"` 的已批准记录（今天的行为），而且这个判断在全仓只出现一次。

### Story 3 — 工具结果的成败是结构化的（P2）

**验收**：
1. **Given** 任意工具失败，**When** 查看 harness 内部，**Then** 失败由 `ToolResult.isError` 表达，
   `TOOL_ERROR_PREFIX` 常量与所有 `startsWith("Error:")` 判断已删除。
2. **Given** 现有的工具失败文案（模型看到的文本），**Then** 逐字不变。

### Edge Cases（必须保持今天的行为）

- abort 时在飞的工具调用要补发取消结果（`abortInFlightToolCalls`），loop 返回前 drain 已派发的工具。
- plan review 的 `reject` / `reject_and_exit` 结束本轮，`revise` / `dismissed` 不结束。
- 被 plan gate 挡掉的写调用：三段计时全为 0，模型收到 `[Plan Mode] …` 文案。
- 审批被拒：模型收到 `[Approval Denied] …` 文案，工具结果 `status` 仍为 `"success"`（今天就是这样，
  前端靠 `approvalDecision` 显示「已拒绝」）。
- `tool_operations` 的 intent 必须在工具 `execute` 开始之前同步写入。
- 子代理与主代理的 `toolCallId` 相同时，`tool_operations` 按 `(runId, agent, toolCallId)` 区分。

## Requirements

### Functional

- **FR-001** harness 只导出一个运行入口 `query({ prompt, options }): Query`，`Query` 是
  `AsyncGenerator<HarnessMessage, void>`。删除 `createAgent`、`Agent.stream`、`Agent.invoke`。
- **FR-002** `Options` 字段名与语义照 Claude Agent SDK 同名同义，字段全集见
  [`contracts/harness-api.ts`](./contracts/harness-api.ts)。不得新增契约之外的字段；确需新增，先改契约并在 PR 说明。
- **FR-003** 授权只有一个入口 `options.canUseTool`，返回 `PermissionResult`（`allow` / `deny`）。
  删除 `RequestApproval`、`RequestPlanReview`、`needsApproval`、`withApproval`、`withPlanGate`。
- **FR-004** harness 内的权限评估顺序固定为：`PreToolUse` hooks → `annotations.readOnlyHint === true` 直放 →
  `canUseTool` → 未提供 `canUseTool` 时 deny。
- **FR-005** `deny.interrupt === true` 时，本轮在当前步的工具全部收口后结束，不再进入下一步。
  删除 `PlanGateState.shouldStopTurn` / `requestStopTurn`。
- **FR-006** 工具定义为 `ToolDefinition`，`execute` 返回 `ToolResult { content, isError? }`。
  删除 `AgentTool`、`buildTool`、`buildJsonSchemaTool` 的旧形状与 `TOOL_ERROR_PREFIX`。
- **FR-007** harness 的输出只有 `HarnessMessage` 一条流。删除 `AgentObserver`、`AgentTelemetryEvent`、
  `onToolExecution`。
- **FR-008** `tool_operations` 的写入改由 server 注册的 `PreToolUse` / `PostToolUse` / `PostToolUseFailure` hooks 完成。
- **FR-009** 子代理角色由 `options.agents` 传入；harness 不再导出 `SUBAGENT_ROLES`。
- **FR-010** 以下判断从 harness 搬到 server，harness 不再导出：`isSafeReadOnlyCommand`、`classifyToolRisk`、
  `buildPolicyKeys`、`matchesPlanGatePath`、`planGateDeniedMessage`。
- **FR-011** SSE 协议（`packages/shared/src/stream-events.ts`）不改；server 用一个纯函数把
  `HarnessMessage` 翻译成现有帧。前端代码零改动。
- **FR-012** `run_events` 中轨迹页（`derive-trajectory.ts`）认识的 26 种 kind 必须全部继续产出，payload 字段不减。

### Non-Functional

- **NFR-001** 风格约束见 [`plan.md` §4](./plan.md#4-代码风格约束必读)，验收时逐条检查。
- **NFR-002** 每个任务完成时：`pnpm typecheck`、`pnpm lint:arch`、`pnpm test` 全绿；碰了 web 再加 `pnpm web:build`。
- **NFR-003** 测试**只改调用形状，不改行为断言**。断言要改，必须在 PR 描述逐条说明「原断言测的是什么、
  为什么新形状下它不成立、用什么断言替代」。
- **NFR-004** harness 依赖仍只有 `ai`、`zod`、`@eva/shared`；不新增 npm 依赖。

## Success Criteria

- **SC-001** `packages/harness/src/index.ts` 的导出只剩：`query`、`tool`、`toolFromJsonSchema`、契约中的类型、
  内置工具工厂、`loadSkills` 等 skill 工具、prompt 段工厂、模型工厂。
- **SC-002** `apps/server/src/modules/observability/observer-bridge.ts` 删除或缩到 80 行以内。
- **SC-003** `grep -rn "TOOL_ERROR_PREFIX\|needsApproval\|onToolExecution\|AgentObserver\|shouldStopTurn" packages apps` 零命中。
- **SC-004** 全量测试数 ≥ 696（可以加，不能少；删测试必须在 PR 里逐个说明它被哪个新测试覆盖）。
- **SC-005** 一次真实对话（启动 `pnpm desktop:dev` 或 server + web）：普通问答、读文件、写文件触发审批、拒绝审批、
  plan mode 全流程、子代理、abort —— 表现与改造前一致。验收人执行。

## Out of Scope

- 上下文压缩、tool-result budget、max-output 续写的逻辑（只允许改调用接线）。
- 评审里的其他缺口：重试、超时、沙箱、prompt cache、tokenizer。
- 前端、SSE 协议、数据库 schema。
- 把 Claude Agent SDK 接成第二个后端。
