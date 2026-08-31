# 24 · Eva Plan Gate × Plan Weave 方案（Kimi Code 闸门 × Alma 任务图）

> 证据来源：
> - Alma：`docs/architecture/20-alma-v2-subsystems.md` §4（plan-mode + Plan Weave）、`docs/architecture/19-alma-v2-tools-skills-sidecars.md` Part 2.2（plan-mode / plan-weave skill）。
> - Kimi Code：`.refrences/kimi-code` @ `8ddcb5c`，重点读 `packages/agent-core-v2/src/features/plan/**`；旧链路口径对照 `packages/agent-core/src/agent/plan/**`、`agent/permission/policies/*plan*`、`agent/injection/plan-mode.ts`。
>
> 本篇是 Eva 的目标方案，不是现状描述。当前 Eva 已有：approval gateway、T43 工具发现（`tool_search` + activeTools）、T44 skill auto-selection / `allowed-tools`、workspaces；还没有 plan mode / plan task graph。
>
> 本篇已经过一轮逐条对仓库 + `.refrences/kimi-code` 的评审修订，修订点集中见 §8。

## 0. 一句话

把「计划批准」和「计划执行」拆成两层：

- **Plan Gate（抄 Kimi Code）**：回答「现在能不能动手改」。它是带审批的规划态：读/查照常，直接写文件类工具被硬闸门挡住，出口是 `exit_plan_mode` + plan review 审批。
- **Plan Weave（抄 Alma）**：回答「多步任务怎么闭环」。它是 workspace 级的文件型任务图：`plan.json + state.json`，核心循环 `claim → execute → submit → review → feedback/resolve`。

不要把这两层揉成一个「plan mode」。Kimi Code 强在闸门、审批分支、reminder 节奏；Alma 强在任务图闭环。Eva 两层都要，但分开落地。

## 1. 不做什么

| 不做 | 理由 |
|---|---|
| 不抄 Alma 的 plan-mode 内存开关 | 太薄，且 Eva 已有审批/运行台账，plan gate 至少要能复盘「批准的是哪版 plan」。 |
| 不抄 Kimi Code 的 event-sourced plan state 全套 | Eva 没有 v2 那套 event dispatcher/blob store；首版用 DB 表 + workspace 文件就够。 |
| 不做 Planner→Builder→Evaluator 五表 harness | Alma 的 `agent_missions/.../sprint_evaluations` 是 opt-in 重型流水线；等 Plan Weave 跑稳再评估。 |
| 不做「skill + bash curl」的 Plan Weave 入口 | 评审已证伪：非 GET `/api/` 要 loopback token（`apps/server/src/app.ts:32-51`），把 token 教进 bash 命令行会进 tool args/消息历史/审批落库；每个 claim/submit 还会因不在 `isSafeReadOnlyCommand` 白名单逐步弹审批。直接做内置工具更省。 |
| 不做 auto-approve plan | Kimi Code 的 auto mode 也明确提示「auto-approved ≠ 用户批准执行」；Eva 的 plan gate 必须经审批中心。免费保障一并保留：`buildPolicyKeys` 对未知工具返回 `[]`，所以 `exit_plan_mode` 天然不可被「始终允许」；后来人给它加 policy key 即视为破红线。 |

## 2. 总体形态

```text
用户说“先规划” / 模型判断任务复杂
  → enter_plan_mode（要求会话已绑 workspace）
  → Eva 进入 Plan Gate：读/查照常；write/edit 只能写当前 plan 文件；bash 等其余工具走正常审批
  → 模型写 plan 文件（每步 reminder 带 plan 路径 + 唯一出口）
  → exit_plan_mode
  → 审批中心 plan_review（批准 / 修订 / 拒绝 / 拒绝并退出）
  → 批准后按 plan 执行；任务大时再接 Plan Weave 任务图
```

```text
Plan Weave（workspace 级，可选）
  <workspace>/.eva/plan-weave/
    plan.json
    state.json
    results/<taskId>/<blockId>.run-N.md
    results/<taskId>/<blockId>.review-N.md
    results/<taskId>/FB-N.md
    results/<taskId>/FB-N.resolution.md
  <workspace>/.eva/plan-weave-archive/<timestamp>-<slug>/
```

## 3. Plan Gate 设计（Kimi Code 闸门）

### 3.1 边界：首版要求 workspace

评审后收敛：**Plan Gate 首版要求会话已绑 workspace**。没绑 workspace 的会话没有 fs 工具（`agent-factory.ts` 工作区注入分支），「能规划」的价值很薄，却要多付一个专用写工具 + 一条 readableRoots 缝。无 workspace 时 plan 工具不注入（见下），万一被调到也直接报错，引导先绑 workspace。

由此 plan 文件直接放 workspace 里，write/edit 现有工具天然可写，不再需要 `write_plan_file` 专用工具，也不需要给 `read_file` 额外开 readableRoots：

```text
<workspace>/.eva/plan-gate/<planId>/current.md
<workspace>/.eva/plan-gate/<planId>/revisions/v<N>.md
```

两层的目录名刻意拉开，不要用 `plans` / `plan` 这种一字之差的兄弟目录（grep、gitignore、代码里都会串）：Plan Gate 用 `.eva/plan-gate/`，Plan Weave 用 `.eva/plan-weave/`。

代价要显式承认：plan 文件从此出现在用户 `git status` 里。这和 tool-overflow 的既有原则是反的（`agent-factory.ts:174` 注释「overflow 落在 `~/.eva/tool-overflow/<id>/`，**不进用户仓库**」）。两层取向不同是有意的——Plan Weave 进仓库是 Alma 的有意选择（`20-alma-v2-subsystems.md` §4.5 坑 2：git 可追踪、人可直接改），Plan Gate 的中间草稿则多半是噪音。首版口径：首次建目录时同时写 `<workspace>/.eva/.gitignore`（内容 `plan-gate/`），已存在则不动；Plan Weave 的文件不 ignore。

`enter_plan_mode` / `exit_plan_mode` 与 fs 工具同一个注入条件（`agent-factory.ts` 的 `if (workspace)` 分支）：无 workspace 时不注入，而不是注入一个必然报错的工具。

### 3.2 状态与表

新增表 `plans`（手写 DDL 仅示意，**最终以 drizzle `schema.ts` 生成的 migration 为准**）：

```sql
CREATE TABLE plans (
  id TEXT PRIMARY KEY,                    -- randomUUID；Eva 没有 hero-slug 生成器，不留不存在的依赖
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                     -- <workspace>/.eva/plan-gate/<planId>/current.md
  status TEXT NOT NULL DEFAULT 'active',  -- active | approved | rejected
  revision_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_plans_session_status ON plans(session_id, status);
```

规则：

- 一个 session 同时最多一个 `active` plan；`enter_plan_mode` 时已有 active 则报错，引导继续改当前 plan 或 `exit_plan_mode`。
- 每次 `exit_plan_mode` 发起审批前，把 `current.md` 复制到 `revisions/v<N>.md` 并 `revision_count + 1`。审批卡看到的是已定版的一版（对齐 Kimi Code `recordRevision()`：见 `exitPlanModeTool.ts` 在生成 `plan_review` display 前记录 revision）。
- plan gate 状态 = DB 里该 session 最新 active plan；run 开始时读入 run-scoped state（见 §3.3），不每次工具执行都查 DB。

### 3.3 工具面与闸门（重点修订）

工具面只加两个：

- `enter_plan_mode`：无参；`readOnly: false`、`needsApproval: false`。它会写 DB/建空 plan 文件，但语义是「进入更受限状态」，不引入对用户代码的修改能力；已有 active 返回错误。别再留「要不要审批」的开放句。
- `exit_plan_mode`：`{ options?: [{ label, description }] }`，options **2–3 个**（1 个没有选择意义；对齐 Kimi `exitPlanModeTool.ts` 只在 `options.length >= 2` 时渲染选项），label 唯一且禁用 `Approve/Reject/Revise/Reject and Exit` 保留字。读当前 plan，非空才生成 plan review。

闸门必须是 **execute 期 getter**，不是 build 期快照：

- run 开始时 server 把该 session 的 active plan 读入一个 run-scoped `PlanGateState`（`{ active, planPath }`），并把它以引用形式同时给 `enter_plan_mode/exit_plan_mode` 和 `withPlanGate`。
- `enter_plan_mode` / `exit_plan_mode` 在 execute 里改这个 state；`withPlanGate` 每次 execute 调 `state.current()`。这与 T43 `getActiveTools?: () => ...`（`context-strategy.ts`）是同款写法。
- 这样「模型在 run 中途 enter」和「approve 后同 run 解除」都成立，不会出现最需要闸门的那个 run 全程裸奔。

包装顺序写死（箭头是**执行序**）：

```text
装配：withConcurrencyCap → withApproval → withPlanGate
执行：withPlanGate → withApproval → withConcurrencyCap
```

理由：planGate 在最外层先挡，避免「被拒的写」还弹审批；现状 `withApproval` 本来就包在 cap 外层（`agent.ts` createAgent，注释「限流在审批内层」），planGate 再包到 approval 外层即可。

放行规则（评审后改成 Kimi 式 deny-list + 审批兜底，不再 allow-list 硬挡）：

- `write` / `edit`（Eva 工具名就是这两个，不是 `write_file/edit_file`）：写路径不等于当前 plan path → 固定文案硬挡，不执行、不进审批；等于 plan path → 放行。
- Kimi 还硬挡 `TaskStop` / `CronCreate` / `CronDelete`，但 **Eva 目前没有这三个工具**（全仓 grep 零命中），别把死规则抄进来，否则读的人会以为 Eva 有 cron。留一句前瞻即可：将来 S7 fork-join 的 stop 类工具、或任何「会改动 plan 退出后才执行的动作」的工具落地时，按同一理由进 deny-list。
- 其余工具：走正常审批/直放规则。`bash` 不额外硬挡——Kimi 明确「Bash follows the normal permission mode and rules」；Eva 现有 `isSafeReadOnlyCommand` 直放 + 危险命令审批照旧。memory 写工具与无 `readOnlyHint` 的 MCP 工具也走各自既有审批语义，不被 plan gate 附加封锁。

放行不等于免审批——写 plan 文件必须额外补一条自动批准：

planGate 在 approval 外层，结构上只有「挡住」和「放进内层」两个输出；放进去之后 `write` / `edit` 仍是 `needsApproval: true`（`write-tool.ts` / `edit-tool.ts`），模型每改一版 plan 都会弹一次窗。Kimi 那边命中 `writesOnlyPlanFile` 走的是 `event.allow()`（`planService.ts`）——**显式跳过审批**；Eva 拿不到这个能力，必须在**审批侧**补等价短路，位置是 `routes/runs.ts` 的 `requestApproval` 闭包，那里已有两个同构先例（T29 `autoApprove(..., "readonly-safe")`、T27/T28 `autoApprove(..., "policy:<key>")`）：

```text
plan active 且 toolName ∈ {write, edit} 且 解析后路径 === planPath
  → approvals.autoApprove(callId, input, "plan-file")   // 落台账，不弹窗
```

三层分工写死，避免后来人在错的层加判断：

| 层 | 只回答 |
|---|---|
| `withPlanGate` | 挡 / 放（输出只有固定 deny 文案或继续） |
| `requestApproval` 闭包 | 放进来之后，是否 `autoApprove` |
| `withApproval` | 只认 boolean，完全不认识 plan |

两处判定必须共用同一个 planPath 事实源（run-scoped `PlanGateState`），不能各自解析路径——否则会漂移成「闸门放行但审批照弹」或反过来。不做这条短路的连带风险很具体：用户被弹烦了会点「始终允许」，而 write 的 policy key 是 `write:thread:<id>:all`（`buildPolicyKeys`），一点就等于**该会话此后所有写文件全部免审批**，plan 退出之后也免。

### 3.4 plan review 审批：不是展示层，是决策协议扩展

现状端到端是 boolean：`RequestApproval => Promise<boolean>`、`approval-gateway resolve/decide(allowed)`、`approval_requests.status` 只有 granted/denied、SSE `ApprovalDecision.action` 只有 granted/denied、`POST /approvals/:callId { allowed }`。plan review 要 5 个出口 + feedback 文本回灌模型，改动面是决策协议，不是 UI 皮。

落法定在**平行通道**：`RequestApproval => Promise<boolean>` 与 `withApproval` 一个字不改，`exit_plan_mode` 用单独注入的 `requestPlanReview` 拿结构化决策（网关侧是 `askPlanReview`）。理由同 §3.3 的三层分工——`withApproval` 就该完全不认识 plan；把 union 塞进 `RequestApproval` 会让每个工具的审批路径都要处理 plan 分支，老 `granted/denied` 行的读兼容也要在每处重写。

因此 T45 拆成两张卡：

- **T45a · 闸门**：`plans` 表、plan 文件、enter/exit 工具、`withPlanGate`、reminder 注入。
- **T45b · 审批决策协议扩展**：决策 union（approve / revise / reject / reject_and_exit / dismissed + feedback + selectedLabel）、`approval_requests.status` 取值扩展与老 `granted/denied` 行的读兼容口径、SSE `ApprovalDecision` 字段扩展、web 决策按钮、`assistant-message-recorder` 决策定格态。老 boolean 行继续按 approve/deny 读。

必须补 Kimi 的 `stopTurn` 语义（`exitPlanModeReview.ts`：reject 与 reject-and-exit 都 `stopTurn: true`）。Eva 的 loop 由 AI SDK 驱动，落点只有一个，直接点名，不留「例如……或……」的开放句：`agent.ts:349` 现在是 `stopWhen: stepCountIs(maxSteps - stepsUsed)`，改成组合谓词——

```text
stopWhen: [stepCountIs(maxSteps - stepsUsed), () => planGateState.shouldStopTurn]
```

标记由 plan review 的 `reject` / `reject_and_exit` 分支置位，随 run-scoped state 一起消失。

五个分支：

- approve：plan `status=approved`，解除闸门；选中 option 时把「只执行选中方案」写回 run 上下文。
- `revise/feedback`：plan 保持 active，feedback 作为 tool result 回灌，模型继续改 plan。
- `reject`：plan 保持 active、当前 run 终止（置 `shouldStopTurn`），等用户说话。
- `reject_and_exit`：plan `status=rejected`、解除闸门、**当前 run 立即终止**；不存在「用户拒绝后模型带着 write/edit/bash 继续跑」的窗口。
- `dismissed`：plan 保持 active，不改 `plans.status`，台账**不记 rejected**。这一支不是 UX 糖——Eva 有两条路必然产生它：用户点 Stop → `cancelByRun` 把 pending 审批全部 `resolve(false)`；进程重启 → `failStalePending` 把 pending 行收成 denied。这两条路要在网关侧显式映射成 `dismissed`，否则「没人拒绝过」的情况会落成 `reject`，台账里出现用户没做过的拒绝决策。对齐 Kimi `exitPlanModeReview.ts` 的 `cancelled` → "Plan approval dismissed. Plan mode remains active."。

`exit_plan_mode` 的审批卡不走 `classifyToolRisk` 的 normal 配色；plan review 是独立渲染分支。

### 3.5 prompt / reminder 层（原最大缺项）

Kimi 做 6 个 reminder 变体不是闲的：模型跨步会忘记自己在 plan mode、忘记 plan 路径。Eva 首版至少要：

- `context-strategy.ts` 的 `extraInstructions` 从构造期数组改成 getter（与 `getActiveTools` 同模式），允许 run 中途进/出 plan mode 改变每步注入。
- plan active 时每步注入一条 plan reminder：当前 plan 路径、唯一出口是 `exit_plan_mode`、直接写文件类工具只能写这个路径。
- 提醒节奏先抄 Kimi 的简化版：进入后 full；持续 active 用 sparse；user 新消息或长间隔后回 full。首版可只做 full + sparse 两档，但 getter 必须先有——否则 plan 路径只会活在 `enter_plan_mode` 的 tool result 里，而那条消息会被 tool-result budget / compact 折走。

## 4. Plan Weave 设计（Alma 任务图）

### 4.1 文件模型

放在 workspace，不放 session：

```text
<workspace>/.eva/plan-weave/
  plan.json      # version/title/goal/tasks[].blocks[]，含 deps/acceptance/maxReviewCycles
  state.json     # blocks 状态、current、feedback[]
  results/...    # run/review/feedback/resolution Markdown
```

沿用 Alma 规则，并补两处评审修正：

- block 状态机：`pending → ready → in_progress → done`，旁路 `blocked`；每次读写按 deps 重算 ready。
- 所有写文件 tmp+rename 原子写；**另外加 per-workspace in-process mutex**——tmp+rename 只保证不读半个 JSON，不防跨 await 的 read-modify-write lost update（同 workspace 两个 run 同时 submit 会互相覆盖）。Fastify 单进程，互斥锁就够。
- `current` 加 `owner: runId`：任务图串行口径落在数据上，谁 claim 的可查；否则「不丢 in_progress 负责人」这条红线不可测。
- claim 幂等：open feedback 优先；已 claim 重发同一 work packet（`alreadyClaimed`）；否则取第一个 ready block。
- review：`needs_changes` 必须带 notes；达到 `maxReviewCycles` 自动关门放行，防 review ping-pong。

### 4.2 server 服务与 API

新增 `apps/server/src/services/plan-weave/`：

- `plan-file-store.ts`：plan.json/state.json 读写、原子写、ready 重算、archive、per-workspace mutex。
- `work-packet.ts`：生成 Markdown work packet（goal、task 上下文、acceptance、instructions、上游报告、submit 调用方式）。
- `service.ts`：`get/getBlock/create/claim/submit/review/resolve/block/reset/archive`。

REST 挂在 workspace 下，避免 `dir` 二义（比上一版补 `block` 详情与 archive）：

```text
GET    /api/v1/workspaces/:id/plan
POST   /api/v1/workspaces/:id/plan
DELETE /api/v1/workspaces/:id/plan
GET    /api/v1/workspaces/:id/plan/block?ref=T1:B1
POST   /api/v1/workspaces/:id/plan/claim
POST   /api/v1/workspaces/:id/plan/submit
POST   /api/v1/workspaces/:id/plan/review
POST   /api/v1/workspaces/:id/plan/resolve
POST   /api/v1/workspaces/:id/plan/blocked
POST   /api/v1/workspaces/:id/plan/reset
POST   /api/v1/workspaces/:id/plan/archive
```

### 4.3 agent 入口：直接做内置工具，不走 curl

评审后改口：首版就做 6 个内置工具，服务端内部调 `PlanWeaveService`，不过 HTTP、不带 token：

- `plan_create`：入参是校验过的 plan 对象（tasks/blocks/deps/acceptance/maxReviewCycles），写出 `plan.json` + 初始 `state.json`。**不能省**：改成内置工具后「skill 教模型 curl POST」这条路已经没了，没有它模型无法生成 plan.json，Plan Gate 批准的 plan 也就没有任何一条能展开成任务图的路径——而这恰好是两层之间的接缝。
- `plan_status`（readOnly）
- `plan_claim`
- `plan_submit`
- `plan_review`
- `plan_resolve`

它们只操作 `<workspace>/.eva/plan-weave/`，由 service 做路径与工作区校验；**工具入参不带任何路径**，路径全部由 service 从 workspace 拼——这才是「不弹审批」站得住的理由，而不是「看起来无害」。不写用户代码，不弹审批（弹了就是逐步人工点击，Plan Weave 没法用）。tool 描述写清「feedback 优先」「work packet 可交给 subagent」。这 6 个工具换的是整个反馈闭环免弹窗，值得。

注入条件同 fs 工具：只在会话绑定 workspace 时注入。

事件/UI 面首版明确：**只有 REST，无 WS 广播、无 UI 面板**。Alma 每次变更广播 `plan_update`；Eva 的 SSE 是 per-run，plan 是 workspace 级，UI 后补，不在这里欠债。

## 5. 和 T43/T44 的关系

- Plan Gate 的写限制发生在工具 execute 前，和 T43 的 activeTools 正交：activeTools 决定「模型能不能看见」，plan gate 决定「看见了能不能直接写」。
- `tool_search` / `read_skill` 在 plan mode 仍可用：规划和查资料不该被闸门卡死。
- skill 的 `allowed-tools` 仍按 T44 合并；plan active 时再由 plan gate 对直接写文件类工具收窄到 plan 路径。
- 常驻工具数增量要框住：plan gate 2 个 + Plan Weave 6 个，都只在绑定 workspace 时注入，别无谓推高 T43 的 40 阈值。

## 6. 落地切片建议

下一轮开 `docs/plans/r12`：

| 卡 | 一句话 | 依赖 |
|---|---|---|
| T45a | Plan Gate 闸门：`plans` 表 + workspace plan 文件 + enter/exit 工具 + run-scoped `PlanGateState` getter + `withPlanGate` + `plan-file` 自动批准短路 + reminder getter | T43/T44、approval gateway |
| T45b | 审批决策协议扩展：approve/revise/reject/reject_and_exit/dismissed + feedback + selectedLabel，DB/SSE/web/recorder 四面 + 老 boolean 行读兼容 + `stopWhen` 组合谓词 | T45a |
| T46 | Plan Weave：workspace `.eva/plan-weave` 文件状态机 + mutex + REST + 6 个内置工具（含 `plan_create`）| workspaces 已有；不依赖 T45 |

T45a 先验收「规划态不能直接写代码、批准后同 run 可解除、改 plan 不弹窗」；T45b 验收五分支与 stopTurn；T46 验收「模型能 `plan_create` 出任务图，并跑完 claim/submit/review/resolve 闭环」。

## 7. 验收红线

- Plan Gate：plan active 时 `write/edit` 到非 plan 路径被固定文案挡住；`bash` 危险命令仍走正常审批；`enter → 写 plan → approve → 同一 run 内继续执行`全程连贯；`reject_and_exit` 解除闸门但当轮立即终止。
- Plan Gate 是护栏，不是沙箱：deny-list 只挡直接写文件类工具，`bash` 在用户批准后仍能 `cat > file`。文档层面不承诺「plan mode 下文件系统只读」，把它当安全边界用即为误用。
- 免审批：plan active 时连续改 3 版 plan，弹窗次数为 0，且台账里有 3 条 `plan-file` 自动批准记录；plan 退出后 `write` 恢复正常审批。
- 决策协议：老 `granted/denied` 行读法不变；plan review 五分支落库/SSE/消息定格一致；点 Stop 或重启进程后，待审的 plan review 落成 `dismissed`——plan 仍 active，台账不记 rejected；`exit_plan_mode` 不出现在「始终允许」候选（`buildPolicyKeys` 对未知工具返回 `[]`，保持）。
- Plan Weave：重复 `claim` 返回同一 packet（`alreadyClaimed`）；`needs_changes` 达到 `maxReviewCycles` 自动关门；两个 run 并发 submit 同 workspace 不丢更新（mutex）；`current.owner` 能回答「这个 in_progress 是谁 claim 的」。
- 两者都不让聊天失败：plan 文件损坏、workspace 缺失、审批网关异常，都要有明确错误文案，不能把 run 卡死。

## 8. 评审修订记录（为什么这版和上一版不同）

### 第一轮

1. plan gate 从 build 期快照改为 run-scoped state + execute 期 getter（对齐 T43 `getActiveTools`）。
2. 包装顺序钉死：装配 cap → approval → planGate，执行 planGate → approval → cap。
3. plan review 从「展示层」改为审批决策协议扩展，并拆 T45a/T45b；补 `stopTurn`。
4. plan 文件从 `~/.eva/plans` 改到 `<workspace>/.eva/plan-gate`（目录名第二轮又改，见 12）；删掉专用 `write_plan_file` 与 readableRoots 缝；首版要求 workspace。
5. plan mode 从 allow-list 硬挡改为 Kimi 式 deny-list：硬挡只留直接写文件类（非 plan 路径）+ TaskStop/Cron（后者第二轮删除，见 13）；bash 等走正常审批。
6. Plan Weave 入口从「skill + bash curl」改为内置工具（不过 HTTP、不带 token、不逐步弹审批）；工具清单第二轮补 `plan_create`，见 11。
7. 补 prompt/reminder 层：`extraInstructions` getter + plan reminder。
8. 小项：per-workspace mutex、`current.owner`、补 `GET block` 与 `plan-archive`、plan id 用 randomUUID、DDL 以 schema.ts 为准、options 2–3、`enter_plan_mode` 定稿 `readOnly:false + needsApproval:false`、plan review 独立渲染分支、写明首版 Plan Weave 无 WS/UI。

### 第二轮（针对第一轮修订带出的连带问题）

9. 补「放行 ≠ 免审批」：planGate 在 approval 外层只能挡/放，写 plan 文件的免审批要在 `routes/runs.ts` 的 `requestApproval` 里 `autoApprove(..., "plan-file")`（同 T29/T27 先例），并钉死三层分工与单一 planPath 事实源。否则每改一版 plan 弹一次窗，用户会点「始终允许」，而 `write:thread:<id>:all` 会让整条会话的写全部免审批。
10. 补回 `dismissed` 第五分支：`cancelByRun`（点 Stop）与 `failStalePending`（重启）必然产生「没人拒绝过」的结局，映射成 `reject` 会在台账里伪造用户决策。
11. 补 `plan_create`（工具数 5 → 6）：改内置工具后模型已无 curl 路径，缺它则 plan.json 无人可写，Plan Gate → Plan Weave 的接缝断开。
12. 目录改名 `.eva/plan-gate/` 与 `.eva/plan-weave/`（原 `plans` / `plan` 一字之差），并显式承认「plan 文件进用户仓库」这个与 tool-overflow「不进用户仓库」相反的取向，给出 `.eva/.gitignore` 口径。
13. 删掉 deny-list 里 Eva 不存在的 `TaskStop` / `CronCreate` / `CronDelete`（全仓零命中），改为前瞻条款；`stopTurn` 从开放句改为点名 `agent.ts:349` 的 `stopWhen` 组合谓词；plan 工具随 workspace 注入并框住 T43 工具数增量；补「Plan Gate 是护栏不是沙箱」红线。
14. 撤销上一轮的 FK 疑问：`db/index.ts:31` 已 `sqlite.pragma("foreign_keys = ON")`，`plans` 的 `ON DELETE CASCADE` 真实生效，不用改。
