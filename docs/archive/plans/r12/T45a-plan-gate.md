# T45a · Plan Gate 闸门（规划态不能直接写代码）

> 前置：无新依赖（approval gateway、workspaces、T43 的 getter 模式都已有）。读 `00-overview.md` §3 契约 1–4、7、10。
> 方案出处：`docs/architecture/24-eva-plan-gate-plan-weave.md` §3.1–3.3、3.5。
> Kimi 证据：`.refrences/kimi-code/packages/agent-core-v2/src/features/plan/planService.ts`（`guardToolExecution` 的 deny-list、`writesOnlyPlanFile` → `event.allow()`）、`enterPlanModeTool.ts`（"Bash follows the normal permission mode and rules"）、`exitPlanModeTool.ts`（`recordRevision()` 先记版再展示、`options.length >= 2` 才渲染）。

## 1. 问题

Eva 现在没有「先规划、批准了再动手」这个态。用户说「先别改，给我个方案」只能靠 prompt 约束，模型随时可以 `write`。审批中心能拦住单次危险写，但拦不住「方向没谈定就开始改十个文件」。

同时不能反向做过头：把 plan mode 做成 allow-list 硬挡（只放行几个读工具）会让规划期连 `bash git log` 都做不了，Kimi 明确不这么干。

## 2. 改动

### 2.1 `plans` 表 + migration

`apps/server/src/db/schema.ts` 新增（形状照 `sessionSkillSelections` 的写法，`schema.ts` 是唯一事实源，migration 由 drizzle 生成）：

```ts
export const planStatuses = ["active", "approved", "rejected"] as const;

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),                       // randomUUID
    sessionId: text("session_id").notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),                      // <workspace>/.eva/plan-gate/<id>/current.md
    status: text("status", { enum: planStatuses }).notNull().default("active"),
    revisionCount: integer("revision_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`)
  },
  (table) => [index("idx_plans_session_status").on(table.sessionId, table.status)]
);
```

新增 `apps/server/src/db/repositories/plan-repository.ts`：`findActive(sessionId)` / `create(...)` / `bumpRevision(id)` / `setStatus(id, status)`。

**一 session 最多一个 active plan**：`create` 前查 `findActive`，已有则由调用方报错。不用 DB 唯一索引（partial unique 在 drizzle 里表达别扭，且这条约束天然属于服务层）。

### 2.2 plan 文件存储

新增 `apps/server/src/services/plan-gate/plan-file-store.ts`：

```text
<workspace>/.eva/plan-gate/<planId>/current.md
<workspace>/.eva/plan-gate/<planId>/revisions/v<N>.md
```

- `ensurePlanDir(workspaceRoot, planId)`：建目录；**同时**在 `<workspace>/.eva/.gitignore` 不存在时写入 `plan-gate/`（已存在则一字不动，绝不追加/去重/重排——那是用户的文件）。
- `readCurrent` / `recordRevision(planId, n)`：把 `current.md` 复制成 `revisions/v<N>.md`。对齐 Kimi：**发起 review 之前**记版，审批卡看到的永远是已定版的一版。
- 目录名必须是 `plan-gate`，不能是 `plans` —— 与 T46 的 `.eva/plan-weave/` 拉开一个词的距离（24 §3.1）。

### 2.3 run-scoped `PlanGateState`

新增 `packages/harness/src/tools/plan-gate/state.ts`：

```ts
export interface PlanGateSnapshot {
  readonly active: boolean;
  readonly planPath?: string;   // 绝对路径
  readonly planId?: string;
}

export interface PlanGateState {
  current(): PlanGateSnapshot;
  enter(input: { planId: string; planPath: string }): void;
  exit(): void;
}

export const createPlanGateState = (initial: PlanGateSnapshot): PlanGateState => { /* 闭包持有 */ };
```

Run 开始时由 server 读 `findActive(sessionId)` 得到初值，同一个引用交给：`enter_plan_mode`、`exit_plan_mode`、`withPlanGate`、reminder getter、`requestApproval` 闭包（§2.6）。这是契约 2 的载体——**只有一份 planPath**。

### 2.4 两个工具

新增 `packages/harness/src/tools/plan-gate/{enter-tool.ts,exit-tool.ts,index.ts}`：

- `enter_plan_mode`：无参；`readOnly: false`、`needsApproval: false`。execute 里调 server 注入的 `onEnter()`（建 plan 行 + 目录）→ 改 state → 返回 workflow 文案（含 plan 绝对路径 + 「唯一出口是 `exit_plan_mode`」）。已有 active → 返回错误文案，引导继续改当前 plan 或退出。
- `exit_plan_mode`：`{ options?: Array<{ label: string; description: string }> }`。校验：plan 非空（空 → isError + 引导先写 plan）；options 给了就必须 **2–3 个**、label 唯一、不许用 `Approve/Reject/Revise/Reject and Exit` 保留字（1 个选项没有选择意义，对齐 Kimi 的 `>= 2` 渲染门槛）。execute 顺序：`recordRevision` → 发起审批 → 按结果改 state/DB。

T45a 阶段出口先用**现有 boolean 审批**（`requestApproval`）：`true` → plan `approved` + `state.exit()`；`false` → plan 保持 `active`、闸门**不解除**、返回「计划未获批准，仍在规划态」。

> 为什么 T45a 不用等 `stopTurn`：被拒后闸门仍开着，模型即使继续跑也写不了代码——没有不安全窗口。五分支与「当轮立即终止」是 T45b 的事。

### 2.5 `withPlanGate` 包装层

新增 `packages/harness/src/tools/plan-gate/with-plan-gate.ts`，形状照 `with-approval.ts`（`{ ...agentTool }` spread 保元数据）：

```text
execute(input):
  snap = state.current()
  if (!snap.active) → innerExecute
  if (tool.name in {"write","edit"}):
      target = 解析入参路径（与 fs 工具同一套 resolveWorkspacePath 语义）
      if (target !== snap.planPath) → return 固定 deny 文案（不执行、不进审批）
  → innerExecute        // 其余一切工具，含 bash / memory / MCP，都不额外硬挡
```

deny 文案固定一句，含 plan 路径 + 「先 `exit_plan_mode` 拿到批准再改代码」。

`agent.ts` 装配处（`agent.ts:664-700`）追加最外层：

```ts
const capTools  = withDiscoveryTools.map((t) => withConcurrencyCap(t, limiter));
const appTools  = requestApproval ? capTools.map((t) => withApproval(t, requestApproval)) : capTools;
const tools     = planGate ? appTools.map((t) => withPlanGate(t, planGate)) : appTools;
```

### 2.6 `plan-file` 自动批准（关键，别漏）

`withPlanGate` 放行不等于免审批——`write`/`edit` 仍是 `needsApproval: true`，模型每改一版 plan 会弹一次窗。在 `apps/server/src/routes/runs.ts` 的 `requestApproval` 闭包里补第三条短路，位置在 `readonly-safe` 之后、`policy` 之前：

```ts
const snap = planGateState.current();
if (snap.active && (toolName === "write" || toolName === "edit") && resolvedPath(args) === snap.planPath) {
  app.services.approvals.autoApprove(toolCallId, { runId, sessionId, tool: toolName, args }, "plan-file");
  return true;
}
```

`reason` 列已有（`schema.ts:281`），落台账不需要改表。这条与 §2.5 的判定必须共用 `planGateState` 与同一个路径解析函数（契约 2）。

不做这条的后果很具体：用户被弹烦了点「始终允许」，而 write 的 policy key 是 `write:thread:<id>:all`，一点等于该会话此后所有写文件全部免审批、plan 退出后也免。

### 2.7 reminder：`extraInstructions` 改 getter

`packages/harness/src/agents/context-strategy.ts:34-35,85`：`extraInstructions?: SystemModelMessage[]` 旁边加 `getExtraInstructions?: () => SystemModelMessage[]`（与 `getActiveTools` 同模式），构造期数组保留、两者取并集，避免改所有调用点。

plan active 时每步注入一条：当前 plan 绝对路径、唯一出口 `exit_plan_mode`、`write/edit` 只能写这个路径。节奏首版两档：刚 enter 或用户新消息后 full 文案，持续 active 用 sparse 一句话。

> 为什么必须是 getter：plan 路径若只活在 `enter_plan_mode` 的 tool result 里，会被 tool-result budget / compact 折走，模型跨步就忘了自己在规划态——这是 Kimi 做 6 个 reminder 变体的原因。

### 2.8 注入条件与工厂接线

`apps/server/src/services/agent-factory.ts:174-190` 的 `if (workspace)` 分支里追加两个 plan 工具（与 fs 工具同一个条件）。无 workspace 时**不注入**，而不是注入一个必然报错的工具。

### 2.9 不做

- 不做 plan review 五分支、不做 feedback 回灌、不做 `stopTurn`（T45b）。
- 不做 plan 列表 UI / plan 历史面板。
- 不给 `exit_plan_mode` 加 policy key（`buildPolicyKeys` 未知工具返回 `[]`，天然不可 always-allow，保持）。
- 不挡 `bash`、不挡 memory 写、不挡无 `readOnlyHint` 的 MCP 工具。

## 3. 涉及文件

新增：

- `apps/server/src/db/repositories/plan-repository.ts`
- `apps/server/src/db/migrations/00XX_plans.sql`（drizzle 生成）
- `apps/server/src/services/plan-gate/{plan-file-store.ts,service.ts,index.ts}`
- `packages/harness/src/tools/plan-gate/{state.ts,enter-tool.ts,exit-tool.ts,with-plan-gate.ts,index.ts}`
- `tests/plan-gate.test.ts`、`tests/plan-gate-approval.test.ts`

修改：

- `apps/server/src/db/schema.ts` — `plans` 表。
- `apps/server/src/deps.ts` / `services/index.ts` — 装 repository / service（三层结构：infra → services → app）。
- `apps/server/src/services/agent-factory.ts` — 注入两个工具 + `PlanGateState` 初值。
- `apps/server/src/routes/runs.ts` — `plan-file` 自动批准短路。
- `packages/harness/src/agents/agent.ts` — 最外层 `withPlanGate` + `planGate` 入参。
- `packages/harness/src/agents/context-strategy.ts` — `getExtraInstructions`。
- `packages/harness/src/tools/index.ts` — 导出 plan-gate。
- `AGENTS.md` — Plan Gate 一节（含「护栏不是沙箱」）。

## 4. 步骤（测试先行）

1. **RED-1（闸门纯函数）**：`tests/plan-gate.test.ts`
   - `active=false` → 任何工具直放；
   - `active=true` + `write` 到 `src/a.ts` → deny 文案，inner execute **未被调用**；
   - `active=true` + `write` 到 planPath → inner 被调用；
   - `active=true` + `bash` / `read_file` / `mcp__x__y` → 全部直放。
2. **RED-2（state 是 execute 期 getter）**：同一组包装后的工具，先 `write` 被挡 → 调 `state.exit()` → 再 `write` 通过。build 期快照实现必然红。
3. **GREEN-1/2**：实现 §2.3、§2.5。
4. **RED-3（表 + 文件 + 定版）**：`create` 后 `findActive` 命中；第二次 `create` 报错；`recordRevision` 后 `revisions/v1.md` 内容 == 当时的 `current.md` 且 `revision_count == 1`；`.eva/.gitignore` 首次生成含 `plan-gate/`，已存在时内容不变。
5. **GREEN-3**：实现 §2.1、§2.2。
6. **RED-4（免弹窗）**：`tests/plan-gate-approval.test.ts` —— plan active 时 `write` planPath 三次 → `approvals.ask` 调用 0 次、台账 3 条 `reason="plan-file"`；`write` 非 plan 路径 → 也是 0 次（被闸门挡在审批之前）；plan 退出后 `write` → `ask` 被调用 1 次。
7. **GREEN-4**：实现 §2.6。
8. **RED-5（端到端 + reminder）**：MockLanguageModel 捕获 `options.messages`——plan active 的每一步都含 plan 路径；`enter → write plan → exit_plan_mode(批准) → write src/a.ts` 全链在**同一个 run** 内通过。
9. **GREEN-5**：实现 §2.4、§2.7、§2.8。
10. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | plan active + `write src/a.ts` | 固定 deny 文案；文件未变；`approvals.ask` 未被调用（不进审批） |
| 2 | plan active + 连改 3 版 plan | 弹窗 0 次；台账 3 条 `reason="plan-file"`；文件真的写进去了 |
| 3 | plan active + `bash "rm -rf x"` | 走正常审批（不被闸门额外硬挡） |
| 4 | run 中途 `enter_plan_mode` | 同 run 后续 `write` 立刻被挡（不是下个 run 才生效） |
| 5 | `exit_plan_mode` 获批 | 同 run 内 `write src/a.ts` 成功；`plans.status == approved` |
| 6 | `exit_plan_mode` 被拒 | plan 仍 `active`；闸门仍挡；文案说明仍在规划态 |
| 7 | `exit_plan_mode` 定版 | 审批发起前 `revisions/v<N>.md` 已存在且等于当时 current |
| 8 | 空 plan 调 `exit_plan_mode` | isError + 引导先写 plan；不发起审批 |
| 9 | options 给 1 个 / 4 个 / 重复 label / `Approve` | 一律参数错误，不发起审批 |
| 10 | 无 workspace 会话 | 工具面里没有 `enter_plan_mode` |
| 11 | 每步注入 | plan active 的每一步 system 段含 plan 绝对路径 |
| 12 | **移除实验**：把 `PlanGateState` 换回 build 期快照 | 用例 4、5 转红；恢复全绿 |

E2E：绑 workspace，说「先规划改造 X」→ 模型 `enter_plan_mode` → 写 plan（无弹窗）→ `exit_plan_mode` 出审批卡 → 点允许 → 同一轮里开始改代码。

## 6. 坑

1. **planPath 两处判定必须共用一个源**。闸门与 `plan-file` autoApprove 各解析一次路径 = 迟早漂移成「闸门放行但审批照弹」。
2. **路径比较要先归一**。`workspace.root` 是 `agent-factory` 用的字段（DB 列叫 `path`）；symlink / `..` / 大小写（macOS）都要过同一个 `resolve` 再比，别拿原始入参字符串比。
3. **`.eva/.gitignore` 只写不改**。那是用户仓库里的文件，已存在就别碰。
4. **闸门在最外层，但审批仍在内层**。别把免审批做进 `withPlanGate`（它拿不到 approval 通道，做进去就是第二条真相源）。
5. **deny 时不能吞掉**。必须返回明确 tool result 文案，否则模型会反复重试同一个写。
6. **一 session 一个 active plan 的判定在服务层**，两个并发 run 同 session 时靠 `create` 前查 + 单进程串行；别指望 DB 约束。
7. **Plan Gate 不是沙箱**（契约 7）。文案不许写成「plan mode 下无法修改文件」。
