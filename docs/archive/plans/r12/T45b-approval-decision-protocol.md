# T45b · plan review 决策协议（五分支 + feedback + 终止本轮）

> 前置：**T45a**（闸门、`plans` 表、`exit_plan_mode` 已在，出口暂用 boolean）。读 `00-overview.md` §3 契约 5、6、9。
> 方案出处：`docs/architecture/24-eva-plan-gate-plan-weave.md` §3.4。
> Kimi 证据：`.refrences/kimi-code/.../exitPlanModeReview.ts` —— 5 个出口：approved（带 `selectedLabel`，"Execute ONLY the selected approach"）、`cancelled` → "Plan approval dismissed. Plan mode remains active."、`Reject and Exit` → `plan.exit()` + `isError, stopTurn: true`、`Revise`/feedback → plan 保持 active、plain reject → `isError, stopTurn: true` 且 plan 保持 active。

## 1. 问题

T45a 的出口只有「批 / 不批」，缺三件东西：

- **修订不能带话**。用户想说「方案 B 更好，但别动 DB 层」，现在只能拒了重说一遍。Kimi 的 `Revise` 把 feedback 作为 tool result 回灌，模型直接改 plan。
- **拒绝不能收尾**。Kimi 的 reject / reject-and-exit 都 `stopTurn: true`；Eva 的 loop 只有 `stopWhen: stepCountIs(...)`（`agent.ts:349`），没有「终止本轮」的钩子。被拒后模型会带着一整轮预算继续絮絮叨叨。
- **「没人拒绝过」被记成拒绝**。`cancelByRun`（用户点 Stop）与启动清扫都把 pending 收成 `denied`。没有 `dismissed` 分支，台账里就会出现用户没做过的拒绝决策。

改动面是决策协议，不是 UI 皮：`RequestApproval => Promise<boolean>`、`approval-gateway` 的 `resolve(allowed: boolean)`、`approval_requests.status` 三值、`ApprovalDecision.action` 两值、`POST /tool-approvals/:callId { allowed }`、`approval-card.tsx` 两个按钮——全链都是 boolean。

## 2. 改动

### 2.0 设计决定：平行通道，不动 boolean 协议

**不**把 union 塞进 `RequestApproval`。`withApproval` 与所有普通工具继续只认 boolean；plan review 走一条平行通道：

```text
exit_plan_mode.execute  →  requestPlanReview(req) : Promise<PlanReviewDecision>
                              ↓
                       approvals.askPlanReview(callId, input)
```

理由（`00-overview.md` 契约 1、5）：三层分工里 `withApproval` 就该「完全不认识 plan」；一旦把 union 塞进 `RequestApproval`，每个工具的审批路径都要处理 plan 分支，而且老 `granted/denied` 行的读兼容要在每处重写。走平行通道则读兼容天然成立——普通工具那条路一个字没改。

代价是网关多一个方法、SSE 多两种帧、前端多一张卡。可控。

### 2.1 决策类型（shared）

`packages/shared/src/stream-events.ts` 附近新增：

```ts
export const planReviewOutcomes = [
  "approve", "revise", "reject", "reject_and_exit", "dismissed"
] as const;
export type PlanReviewOutcome = (typeof planReviewOutcomes)[number];

export interface PlanReviewDecision {
  readonly outcome: PlanReviewOutcome;
  readonly feedback?: string;       // revise 必填；reject 可选
  readonly selectedLabel?: string;  // approve 且用户选了 option 时
  readonly decidedAt: string;
}
```

`ApprovalDecision` 保持原样（两值），不去污染普通工具的定格态。

### 2.2 落库：`status` enum 扩展 + 读兼容

`apps/server/src/db/schema.ts:273` 的 `approval_requests.status` enum 扩成：

```ts
["pending", "granted", "denied", "revise", "reject_and_exit", "dismissed"]
```

`granted`/`denied` 继续承载普通工具与 plan 的 approve/reject——**老行读法一个字不变**（契约：`granted` 读作批准，`denied` 读作拒绝）。新增三值只有 plan review 会写。migration 是纯 enum 放宽（SQLite 上 `text` 列无 CHECK，drizzle 生成的 migration 可能是空的；若为空则手写一条注释 migration 说明语义变更，别让 `meta` 与 schema 失联）。

`plans.status` 不加新值：`revise`/`dismissed` 都保持 `active`，`reject` 也保持 `active`，只有 `reject_and_exit` 写 `rejected`、`approve` 写 `approved`。

### 2.3 网关：`askPlanReview`

`apps/server/src/services/approval-gateway.ts`：

- `PendingRequest` 的 `resolve` 泛化为 `(decision: boolean | PlanReviewDecision) => void`，并记一个 `kind: "tool" | "plan_review"`。
- `askPlanReview(callId, input): Promise<PlanReviewDecision>`。
- `decidePlanReview(callId, decision)`：写 `approval_requests.status`（映射见 §2.2）+ resolve。
- **`cancelByRun` 与启动清扫的映射（契约 6）**：`kind === "plan_review"` 的 pending 收成 `dismissed`（`repo.decide(callId, "dismissed")` + `resolve({ outcome: "dismissed" })`）；`kind === "tool"` 行为一字不改（仍 `denied` + `resolve(false)`）。启动清扫（`ApprovalRepository.failStalePending`）同理按 `tool` 列分流。

### 2.4 REST

`apps/server/src/routes/approvals.ts` 新增一条，不改老的：

```text
POST /api/v1/tool-approvals/:callId/plan-review
     { outcome, feedback?, selectedLabel? }
```

校验：`outcome ∈ planReviewOutcomes` 且 `!== "dismissed"`（dismissed 只能由系统产生，不接受前端提交）；`revise` 必须带非空 `feedback`；`approve` 的 `selectedLabel` 必须在该次 review 提供的 options 里。老 `POST /:callId { allowed }` 保持原样。

### 2.5 SSE 帧

`packages/shared/src/stream-events.ts` 新增两种，与 `approval_request/approval_resolved` 并列：

```ts
{ type: "plan_review_request",  callId, planId, planPath, planMarkdown, options?, revision }
{ type: "plan_review_resolved", callId, decision: PlanReviewDecision }
```

`planMarkdown` 直接带正文（前端不必再拉一次文件；plan 正文本来就是给人读的）。`replay-events` 与 `assistant-message-recorder` 一并支持定格：消息 part 里存 `PlanReviewDecision`，刷新后卡片显示「已批准 · 方案 B」这类定格态，与 T30 的写回口径一致。

### 2.6 「终止本轮」= `stopWhen` 组合谓词

契约里唯一的落点（`agent.ts:349`）：

```ts
stopWhen: [stepCountIs(maxSteps - stepsUsed), () => planGateState.shouldStopTurn]
```

`PlanGateState` 加 `shouldStopTurn: boolean` + `requestStopTurn()`，由 `exit_plan_mode` 的 `reject` / `reject_and_exit` 分支置位，随 run-scoped state 消失（不落库、不跨 run）。

> 不做「tool result 携带 `stopTurn`」那种通用机制：AI SDK 的 loop 不读工具返回值来决定停，硬做要在 harness 里再造一层，收益为零。

### 2.7 五分支行为表

| outcome | `plans.status` | 闸门 | 本轮 | tool result |
|---|---|---|---|---|
| `approve` | `approved` | 解除 | 继续 | 「已批准」+ 选中 option 时附「只执行选中方案」 |
| `revise` | `active` | 保持 | 继续 | 回灌 feedback 原文，要求改 plan 后重新 `exit_plan_mode` |
| `reject` | `active` | 保持 | **终止** | isError + 「计划被拒，仍在规划态」+ feedback（若有） |
| `reject_and_exit` | `rejected` | 解除 | **终止** | isError + 「计划被拒且已退出规划态」 |
| `dismissed` | `active` | 保持 | 随 run 已结束 | 「审批被撤下，仍在规划态」（对齐 Kimi 文案语义） |

`reject_and_exit` 解除闸门 + 立即终止两件事必须同时发生——只解除不终止就是「用户拒绝后模型带着 `write/edit/bash` 继续跑」的窗口。

### 2.8 前端

`apps/web/src/features/threads/components/plan-review-card.tsx`（新，不改 `approval-card.tsx`）：

- 渲染 plan Markdown + revision 号 + options（2–3 个，点选即 approve + `selectedLabel`）。
- 四个操作：批准 / 修订（弹输入框，必填）/ 拒绝（feedback 可选）/ 拒绝并退出。
- 定格态读消息 part 里的 `PlanReviewDecision`；`dismissed` 显示为灰色「已撤下」，**不是**红色拒绝。
- `use-approvals.ts` 加 `decidePlanReview`；`plan_review_request/resolved` 帧接进 `applyStreamEvent`。
- plan review 卡不走 `classifyToolRisk` 配色（它不是危险工具，是决策）。

### 2.9 不做

- 不改 `RequestApproval`、`withApproval`、普通工具审批链。
- 不做 plan diff 视图、不做 revision 历史浏览。
- 不接受前端提交 `dismissed`。
- 不给 plan review 加「始终允许」（`buildPolicyKeys` 未知工具返回 `[]`，保持；给它加 policy key 视为破红线）。

## 3. 涉及文件

新增：

- `apps/web/src/features/threads/components/plan-review-card.tsx`
- `tests/plan-review-protocol.test.ts`、`tests/plan-review-dismiss.test.ts`

修改：

- `packages/shared/src/stream-events.ts` — `PlanReviewOutcome/Decision` + 两种帧。
- `apps/server/src/db/schema.ts` + 一条 migration — `status` enum 放宽。
- `apps/server/src/db/repositories/approval-repository.ts` — `decide` 接新值；`failStalePending` 按 kind 分流。
- `apps/server/src/services/approval-gateway.ts` — `askPlanReview/decidePlanReview` + `cancelByRun` 分流。
- `apps/server/src/routes/approvals.ts` — 新增 plan-review 端点。
- `apps/server/src/routes/runs.ts` — 注入 `requestPlanReview`；emit 两种帧。
- `apps/server/src/services/runs/assistant-message-recorder.ts` — 决策定格。
- `packages/harness/src/tools/plan-gate/{exit-tool.ts,state.ts}` — 五分支 + `shouldStopTurn`。
- `packages/harness/src/agents/agent.ts` — `stopWhen` 组合谓词。
- `apps/web/src/features/threads/{hooks/use-approvals.ts,components/chat-view.tsx,api.ts}`。
- `tests/approval-abort.test.ts`、`tests/approval-decision-writeback.test.ts` — 补 plan review 场景（老断言不许改）。

## 4. 步骤（测试先行）

1. **RED-1（读兼容基线先钉住）**：跑现有 `tests/approval-*.test.ts`，一行不改，全绿即基线。**任何让这些用例变红的实现都是错的。**
2. **RED-2（五分支）**：`tests/plan-review-protocol.test.ts` —— 五个 outcome 各一条：`plans.status`、闸门解除与否、`shouldStopTurn` 与否、tool result 文案关键字。
3. **GREEN-2**：实现 §2.1–2.3、§2.7。
4. **RED-3（dismissed 两条路）**：`tests/plan-review-dismiss.test.ts` ——
   - `cancelByRun(runId)` 后：`approval_requests.status == "dismissed"`、`plans.status` 仍 `active`、**台账里没有 `denied` 行**；
   - 同一个 run 里另有一个普通工具 pending → 它仍是 `denied`（老行为不许被带跑）；
   - 模拟重启走启动清扫 → 同上。
5. **GREEN-3**：实现 §2.3 的分流。
6. **RED-4（stopTurn）**：MockLanguageModel 让模型在 `exit_plan_mode` 之后还想再调工具 —— `reject` / `reject_and_exit` 后 loop 不再进下一步；`revise` 后继续进下一步且 feedback 出现在 messages 里。
7. **GREEN-4**：实现 §2.6。
8. **RED-5（REST + 帧 + 定格）**：非法 outcome / `revise` 缺 feedback / 前端提 `dismissed` → 4xx；`plan_review_resolved` 后刷新页面，卡片仍是定格态。
9. **GREEN-5**：实现 §2.4、§2.5、§2.8。
10. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | 老审批用例全套 | 一行不改仍全绿（`granted/denied` 读法不变） |
| 2 | `approve` + 选 option B | plan `approved`、闸门解除、tool result 含「只执行选中方案 B」 |
| 3 | `revise` + feedback | plan 仍 `active`、闸门仍开、feedback 原文进下一步 messages |
| 4 | `reject` | plan 仍 `active`、`shouldStopTurn` 命中、loop 不再进下一步 |
| 5 | `reject_and_exit` | plan `rejected` + 闸门解除 + 当轮立即终止（三件事同时） |
| 6 | 点 Stop（`cancelByRun`） | plan review 落 `dismissed`、plan 仍 `active`、无 `denied` 行；同 run 的普通工具仍 `denied` |
| 7 | 进程重启清扫 | 同 6 |
| 8 | 前端提交 `dismissed` | 4xx |
| 9 | `revise` 不带 feedback | 4xx |
| 10 | 刷新页面 | plan review 卡定格态正确；`dismissed` 显示为灰色「已撤下」而非红色拒绝 |
| 11 | **移除实验**：把 `dismissed` 映射删掉，回落 `denied` | 用例 6、7 转红；恢复全绿 |

E2E：`enter → 写 plan → exit(给 2 个 option)` → 卡片出现 → 点「修订」写一句话 → 模型改 plan 再 `exit` → 点方案 B → 同轮开始按 B 执行。另一遍：`exit` 后直接点 Stop → 卡片变「已撤下」，plan 仍在规划态。

## 6. 坑

1. **读兼容是硬约束**。老 `granted/denied` 行含义不许变；`dismissed` 是新值而不是「`denied` 的一种」。
2. **`cancelByRun` 要按 kind 分流**。一把梭全改 `dismissed` 会把普通工具的拒绝语义也改了（用户点 Stop 时那些工具确实该算拒绝）。
3. **`reject` 与 `reject_and_exit` 的差别只在闸门与 plan status**，两者都终止本轮，别混。
4. **`shouldStopTurn` 不能落库**。它是 run-scoped 的一次性信号；持久化会让下一个 run 一启动就停。
5. **`stopWhen` 谓词要读 getter**，别在数组构造时求值成 `false` 常量。
6. **feedback 是用户原文**，别摘要、别改写、别截断——用户写「不要动 DB 层」时任何加工都可能反转语义。
7. **plan review 卡不复用 `approval-card.tsx`**。硬塞进去会把两个不同的决策模型耦合在一个组件里，后面两边都改不动。
