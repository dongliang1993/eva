# r12 · S26 Plan Gate 闸门 × 审批决策协议 × Plan Weave 任务图

> 切片编号 **S26**，来源 `docs/architecture/24-eva-plan-gate-plan-weave.md`（已过两轮评审，修订点见该文 §8）。
> 前置阅读：24 全文（尤其 §3.3 三层分工表、§3.4 五分支、§4）；`docs/architecture/20-alma-v2-subsystems.md` §4（Plan Weave 原型）；`../r11/00-overview.md` 的任务卡格式。
> Kimi 证据：`.refrences/kimi-code` @ `8ddcb5c`，`packages/agent-core-v2/src/features/plan/**`。

## 1. 目标

把「计划批准」和「计划执行」拆成两层落地，不揉成一个 plan mode：

1. **Plan Gate（T45a）**：带审批的规划态。读/查照常，`write`/`edit` 只能写当前 plan 文件（且免弹窗），出口只有 `exit_plan_mode`。首版复用现有 boolean 审批，先把闸门本身钉死。
2. **审批决策协议（T45b）**：plan review 需要 5 个出口 + feedback 回灌，现状端到端是 boolean。本卡**只**扩 plan review 这一条通道，不动普通工具的 boolean 协议。
3. **Plan Weave（T46）**：workspace 级文件型任务图 `plan.json + state.json`，闭环 `claim → execute → submit → review → feedback/resolve`，6 个内置工具，不过 HTTP、不带 token。

## 2. 现状盘点（代码实证）

| 能力 | 现状 | 位置 |
|---|---|---|
| 工具审批 | ✅ boolean 端到端；`ask/decide/autoApprove/cancelByRun` 齐全 | `apps/server/src/services/approval-gateway.ts` |
| 自动批准先例 | ✅ 两条：T29 `"readonly-safe"`、T27/T28 `"policy:<key>"` | `apps/server/src/routes/runs.ts:62-92` |
| 审批落库 | ⚠️ `status` enum 只有 `pending/granted/denied`；已有 `reason` 列 | `apps/server/src/db/schema.ts:265-288` |
| 审批决策帧 | ⚠️ `ApprovalDecision.action` 只有 `granted/denied` | `packages/shared/src/stream-events.ts:155-177` |
| 审批 REST | ⚠️ `POST /tool-approvals/:callId { allowed: boolean }` | `apps/server/src/routes/approvals.ts:3-43` |
| 审批 UI | ⚠️ 两个按钮 + 定格态按 `action === "granted"` 判 | `apps/web/src/features/threads/components/approval-card.tsx:8,110-145` |
| 工具包装链 | ✅ 装配 `withConcurrencyCap` → `withApproval`（注释「限流在审批内层」） | `packages/harness/src/agents/agent.ts:664-700` |
| 每步注入 | ⚠️ `getActiveTools` 已是 getter；`extraInstructions` 仍是构造期数组 | `packages/harness/src/agents/context-strategy.ts:34-35,85` |
| loop 停止 | ⚠️ 只有 `stopWhen: stepCountIs(maxSteps - stepsUsed)`，无「终止本轮」钩子 | `packages/harness/src/agents/agent.ts:349` |
| fs 工具注入 | ✅ `if (workspace)` 分支，`workspace.root` 作 workRoot | `apps/server/src/services/agent-factory.ts:174-190` |
| 写工具审批位 | ✅ `write`/`edit`/`bash` 均 `needsApproval: true` | `packages/harness/src/tools/fs/{write,edit,bash}-tool.ts` |
| 「始终允许」候选 | ✅ `buildPolicyKeys` 未知工具返回 `[]` → `exit_plan_mode` 天然不可 always-allow | `apps/server/src/services/approval-policy-store.ts` |
| FK 级联 | ✅ `foreign_keys = ON` 已开，`plans` 的 CASCADE 真实生效 | `apps/server/src/db/index.ts:31` |
| workspaces | ✅ 表 + REST 已有（`id/name/path`） | `schema.ts:29-36`、`routes/workspaces.ts` |
| plan 相关一切 | ❌ 无 plan mode、无任务图、无 `TaskStop/Cron` 工具（全仓零命中） | — |

**结论：S26 不需要重做审批中心，也不需要动 boolean 协议。T45a 在包装链最外层加一层闸门并借 `autoApprove` 免弹窗；T45b 只为 plan review 开一条平行通道；T46 完全独立于 T45，可并行开工。**

## 3. 执行契约

1. **闸门只回答挡不挡**。`withPlanGate` 的输出只有「固定 deny 文案」或「继续」。免不免审批归 `routes/runs.ts` 的 `requestApproval` 闭包；`withApproval` 永远只认 boolean、完全不认识 plan（24 §3.3 三层分工表）。
2. **planPath 单一事实源**。闸门与 autoApprove 两处判定都从 run-scoped `PlanGateState` 取 planPath，不各自解析——与 T29「共用 `isSafeReadOnlyCommand`」同一条纪律（r7 §3 契约 2）。
3. **闸门状态是 execute 期 getter，不是 build 期快照**。否则「模型在 run 中途 enter」和「approve 后同 run 解除」都不成立，最需要闸门的那个 run 会全程裸奔。
4. **包装顺序写死**：装配 `cap → approval → planGate`，执行 `planGate → approval → cap`。planGate 在最外层先挡，避免「被拒的写」还弹审批。
5. **plan review 走平行通道，不改 boolean 协议**。`RequestApproval => Promise<boolean>` 保持原样；`exit_plan_mode` 用注入的 `requestPlanReview` 拿结构化决策。理由是契约 1：一旦把 union 塞进 `RequestApproval`，每个工具的审批路径都要认识 plan。老 `granted/denied` 行读法因此天然不变。
6. **`dismissed` 是必须实现的分支，不是 UX 糖**。`cancelByRun`（点 Stop）与启动清扫（`failStalePending`）必然产生「没人拒绝过」的结局；落成 `reject` 等于在台账里伪造用户决策。
7. **Plan Gate 是护栏，不是沙箱**。deny-list 只挡直接写文件类工具；`bash` 在用户批准后仍能 `cat > file`。任何文档/文案都不许承诺「plan mode 下文件系统只读」。
8. **Plan Weave 工具入参不带路径**。路径全部由 service 从 workspace 拼——这才是这 6 个工具「不弹审批」站得住的理由。
9. **两层都不让聊天失败**。plan 文件损坏、workspace 缺失、审批网关异常、plan.json 非法，都要有明确错误文案，不能把 run 卡死。
10. **不留死规则**。Kimi 的 `TaskStop/CronCreate/CronDelete` 在 Eva 不存在，不抄；将来这类工具落地时再按同一理由进 deny-list。

## 4. 任务卡

| 卡 | 文件 | 一句话 | 估时 | 依赖 |
|---|---|---|---|---|
| **T45a** | `T45a-plan-gate.md` | `plans` 表 + `<workspace>/.eva/plan-gate/` 文件 + `enter/exit_plan_mode` + run-scoped `PlanGateState` + `withPlanGate` + `plan-file` 自动批准 + reminder getter；出口先用现有 boolean 审批 | 1.5–2 天 | approval gateway、workspaces（均已有） |
| **T45b** | `T45b-approval-decision-protocol.md` | plan review 平行通道：`PlanReviewDecision` 五分支 + `askPlanReview` + `status` enum 扩展 + SSE 帧 + web plan-review 卡 + `stopWhen` 组合谓词 | 1.5 天 | T45a |
| **T46** | `T46-plan-weave.md` | `<workspace>/.eva/plan-weave/` 文件状态机 + per-workspace mutex + 11 条 REST + 6 个内置工具（含 `plan_create`） | 2–2.5 天 | workspaces（已有）；**不依赖 T45** |

**顺序**：T45a → T45b 串行（T45b 要改的正是 T45a 落下的出口）；T46 与它们并行，唯一接触点是 §5 的交接口径。

## 5. 两层的交接口径（先说清，避免各写一半）

- Plan Gate 产出的是**人读的 Markdown plan**；Plan Weave 吃的是**机器读的 `plan.json`**。两者不共享文件，也不共享目录（`.eva/plan-gate/` vs `.eva/plan-weave/`）。
- 交接靠模型：plan 被 approve 后，若任务足够大，模型自己调 `plan_create` 把批准的方案展开成任务图。**没有自动转换**，首版也不做校验「plan.json 是否忠于 plan.md」。
- 因此 `plan_create` 不能省（24 §4.3）：它是唯一能把批准结果变成任务图的路径。

## 6. 验收总表

| 卡 | 一句话验收 |
|---|---|
| T45a | plan active 时 `write` 到 `src/x.ts` 被固定文案挡住（不执行、不进审批）；写 `.eva/plan-gate/<id>/current.md` 直接执行且弹窗次数 0、台账 3 条 `plan-file`；`enter → 写 plan → approve → 同一 run 内继续写代码`连贯；每步 system 注入含 plan 路径 |
| T45b | 五分支落库/SSE/消息定格一致；`revise` 的 feedback 回灌后模型继续改 plan；`reject`/`reject_and_exit` 当轮立即终止（`stopWhen` 命中）；点 Stop 或重启后待审 plan review 落 `dismissed` 且 plan 仍 active；老 `granted/denied` 行读法不变 |
| T46 | 模型能 `plan_create` 出任务图并跑完 `claim → submit → review → resolve`；重复 `claim` 返回同一 packet（`alreadyClaimed`）；`needs_changes` 达 `maxReviewCycles` 自动关门；两个 run 并发 submit 不丢更新；`current.owner` 能回答「这个 in_progress 是谁 claim 的」 |

S26 切片全绿 = T45a–T46 全绿 + `pnpm typecheck && pnpm test` 全绿。
