# T46 · Plan Weave（workspace 级文件型任务图）

> 前置：workspaces 已有（`schema.ts:29-36`、`routes/workspaces.ts`）。**不依赖 T45**，可与 T45a/T45b 并行。读 `00-overview.md` §3 契约 8、9 与 §5 交接口径。
> 方案出处：`docs/architecture/24-eva-plan-gate-plan-weave.md` §4。
> Alma 证据：`docs/architecture/20-alma-v2-subsystems.md` §4（`.alma/plan/` 文件模型、11 条路由、claim 幂等、`maxReviewCycles`、`plan_update` 广播、`plan-archive`）。

## 1. 问题

Eva 现在做多步任务靠模型自己在上下文里记着「第 3 步做完了」。上下文一压缩就丢，换个 run 更无从接手；也没有「产出被 review 过」这一环。

Alma 的解法是文件型任务图：状态在磁盘上，人能直接看能直接改，git 能追踪，换 run / 换 agent 都能接着干。Eva 抄这套，但入口做成内置工具（不走 skill + bash curl —— 那条路要把 loopback token 教给模型，会把 token 写进 tool args / 消息历史 / 审批台账）。

## 2. 改动

### 2.1 文件模型

```text
<workspace>/.eva/plan-weave/
  plan.json      # version/title/goal/tasks[].blocks[]，含 deps/acceptance/maxReviewCycles
  state.json     # blocks 状态、current、feedback[]
  results/<taskId>/<blockId>.run-N.md
  results/<taskId>/<blockId>.review-N.md
  results/<taskId>/FB-N.md
  results/<taskId>/FB-N.resolution.md
<workspace>/.eva/plan-weave-archive/<timestamp>-<slug>/
```

目录名是 `plan-weave`，不是 `plan` —— 与 T45a 的 `.eva/plan-gate/` 拉开一个词（24 §3.1）。这些文件**不**写进 `.gitignore`：Plan Weave 进 git 是有意的（人可直接改、可追踪），与 plan-gate 草稿的取向相反。

`state.json` 形状（比 Alma 多一个 `owner`）：

```jsonc
{
  "blocks": { "T1:B1": { "status": "done", "runs": 2, "reviews": 1 } },
  "current": { "kind": "block", "id": "T1:B2", "claimedAt": "...", "owner": "<runId>" },
  "feedback": [{ "id": "FB-1", "blockId": "T1:B1", "status": "open" }]
}
```

`owner` 是必须的：没有它，「不丢 in_progress 负责人」这条红线不可测。

### 2.2 状态机与 ready 重算

- block：`pending → ready → in_progress → done`，旁路 `blocked`。
- **每次读写都按 deps 重算 ready**，不把 ready 当持久字段（deps 全 `done` 即 ready）。人手改了 `plan.json` 也能自愈。
- review：`needs_changes` 必须带 notes，写 `<blockId>.review-N.md`，block 回 `ready`，`reviews + 1`；`reviews >= maxReviewCycles` 时**自动关门放行**（记一条「已达上限，强制通过」到 review 文件），防 review ping-pong 把预算烧光。
- feedback：`open` 的 feedback 永远优先于新 block（claim 的第一条规则）。

### 2.3 原子写 + per-workspace mutex

`apps/server/src/services/plan-weave/plan-file-store.ts`：

- 所有写：写 `<file>.tmp` → `fsync` → `rename`。保证读不到半个 JSON。
- **另加 per-workspace in-process mutex**：tmp+rename 不防跨 `await` 的 read-modify-write lost update（同 workspace 两个 run 同时 submit 会互相覆盖）。Fastify 单进程，`Map<workspaceId, Promise>` 串行化就够。
- 每个 mutation 都是「进锁 → 读 → 改 → 原子写 → 出锁」，锁内不做 LLM 调用、不做长 IO。

### 2.4 service

`apps/server/src/services/plan-weave/service.ts`：`get / getBlock / create / claim / submit / review / resolve / block / reset / archive`。

- `create(workspaceId, plan)`：校验 plan 形状（zod）——`tasks[].blocks[]` 非空、`deps` 只引用已存在的 `taskId:blockId`、**无环**、`maxReviewCycles >= 1`；已有 plan 则要求先 `archive` 或 `reset`（不静默覆盖）。
- `claim(workspaceId, runId)`：① 有 `open` feedback → 返回 feedback packet；② `current` 已被占且 `owner === runId` → **重发同一 packet 并标 `alreadyClaimed: true`**（幂等）；③ `current` 被别的 run 占 → 返回 busy + owner；④ 否则取第一个 ready block，写 `current` 含 `owner: runId`。
- `submit`：写 `<blockId>.run-N.md`，block → 等待 review。
- `review`：`approved` → `done` + 清 `current`；`needs_changes` → 见 §2.2。
- `resolve`：写 `FB-N.resolution.md`，feedback → `resolved`。
- `archive`：整个目录 move 到 `plan-weave-archive/<timestamp>-<slug>`。

`work-packet.ts`：生成人/模型都能读的 Markdown work packet —— goal、所在 task 上下文、acceptance、instructions、上游 block 的报告摘要、**「产出后调 `plan_submit`」**（不是 curl）。

### 2.5 REST（11 条，挂在 workspace 下）

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

挂在 workspace 下而不是接 `dir` 参数：`dir` 会带来「这个目录是不是那个 workspace」的二义，还会变成一个可被喂任意路径的入口。

### 2.6 六个内置工具

`packages/harness/src/tools/plan-weave/`（tool 工厂吃一个 `PlanWeaveGateway` 接口，server 侧实现为直接调 service —— **不过 HTTP、不带 token**）：

| 工具 | 入参 | 说明 |
|---|---|---|
| `plan_create` | `{ plan: PlanInput }` | 写出 `plan.json` + 初始 `state.json`。**不能省**：改内置工具后模型已无 curl 路径，缺它则任务图无人可造，Plan Gate 批准的方案也没有能展开成任务图的路径（24 §4.3） |
| `plan_status` | `{}` | `readOnly: true`。返回进度概览 + `current` + open feedback |
| `plan_claim` | `{}` | 取下一个工作单元，返回 work packet |
| `plan_submit` | `{ ref, report }` | 提交产出 |
| `plan_review` | `{ ref, verdict, notes? }` | `needs_changes` 必带 notes |
| `plan_resolve` | `{ feedbackId, resolution }` | 关闭 feedback |

契约：

- **入参不带任何路径**（契约 8）。`workspaceId` 由 server 从会话绑定的 workspace 注入，不从模型入参取。这才是这些工具「不弹审批」站得住的理由。
- `needsApproval` 不设（默认 false）。弹了就是逐步人工点击，Plan Weave 没法用。
- 只有 `plan_status` 标 `readOnly: true`（其余会写文件，标了会被 T24 并发上限误当只读放行）。
- 注入条件同 fs 工具：`agent-factory.ts` 的 `if (workspace)` 分支内（无 workspace 则无 plan weave）。
- tool 描述写清「open feedback 优先」「work packet 可整段交给 subagent」。

### 2.7 不做

- **不做 WS 广播、不做 UI 面板**。Alma 每次变更广播 `plan_update`；Eva 的 SSE 是 per-run 而 plan 是 workspace 级，首版只有 REST。UI 后补，不在这里欠债。
- 不做 Planner→Builder→Evaluator 五表 harness。
- 不做跨 workspace 的 plan、不做 plan 模板库。
- 不校验 `plan.json` 是否忠于某份 plan.md（§5 交接口径：靠模型，不做自动转换）。

## 3. 涉及文件

新增：

- `apps/server/src/services/plan-weave/{plan-file-store.ts,ready.ts,work-packet.ts,service.ts,schema.ts,index.ts}`
- `apps/server/src/routes/plan-weave.ts`
- `packages/harness/src/tools/plan-weave/{gateway.ts,tools.ts,index.ts}`
- `tests/plan-weave-store.test.ts`、`tests/plan-weave-loop.test.ts`、`tests/plan-weave-tools.test.ts`

修改：

- `apps/server/src/deps.ts` / `services/index.ts` / `routes/index.ts` — 三层接线。
- `apps/server/src/services/agent-factory.ts` — workspace 分支注入 6 个工具。
- `apps/server/src/paths.ts` — `planWeaveDir(workspaceRoot)` / `planWeaveArchiveDir(workspaceRoot)`（与 `toolOverflowDir` 并列，路径拼接只有一处）。
- `packages/harness/src/tools/index.ts` — 导出。
- `AGENTS.md` — Plan Weave 一节。

## 4. 步骤（测试先行）

1. **RED-1（store 纯函数）**：`tests/plan-weave-store.test.ts`
   - ready 重算：deps 未完 → `pending`；deps 全 `done` → `ready`；
   - 环形 deps → `create` 报错；
   - `deps` 引用不存在的 ref → 报错；
   - 手改 `plan.json` 后重算能自愈。
2. **RED-2（并发）**：同 workspace 两个 `submit` 并发 → 两次更新都在（无 lost update）；去掉 mutex 必红。
3. **GREEN-1/2**：实现 §2.1–2.3。
4. **RED-3（闭环）**：`tests/plan-weave-loop.test.ts`
   - `create → claim(T1:B1) → submit → review(approved) → claim(T1:B2)`；
   - 重复 `claim` 同 runId → `alreadyClaimed: true` 且 packet 相同；
   - 别的 runId `claim` → busy + owner 可见；
   - `needs_changes` 无 notes → 报错；
   - `reviews` 达 `maxReviewCycles` → 自动关门，block `done`；
   - open feedback 存在时 `claim` 先给 feedback。
5. **GREEN-3**：实现 §2.4。
6. **RED-4（工具层）**：`tests/plan-weave-tools.test.ts` —— 6 个工具都不触发 `approvals.ask`；`plan_status` 是 `readOnly: true` 且其余不是；工具入参里塞路径字段被忽略/拒绝（不影响实际写入位置）。
7. **GREEN-4**：实现 §2.6。
8. **RED-5（REST）**：11 条路由的 happy path + 404（workspace 不存在）+ 409（已有 plan 时 `create`）。
9. **GREEN-5**：实现 §2.5。
10. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | `plan_create` 合法 plan | `plan.json` + `state.json` 落盘；`plan_status` 返回正确进度 |
| 2 | `plan_create` 环形 deps / 空 blocks / `maxReviewCycles=0` | 报错且不落盘 |
| 3 | 已有 plan 时 `plan_create` | 报错，提示先 archive/reset；旧 plan 不被覆盖 |
| 4 | 完整闭环 | `claim → submit → review(approved) → claim` 推进到下一个 ready block |
| 5 | 重复 `claim` 同 run | 同一 packet + `alreadyClaimed: true`（不产生第二个 in_progress） |
| 6 | 另一 run `claim` | busy + `owner` 是第一个 runId |
| 7 | `needs_changes` | 必带 notes；block 回 `ready`；`reviews + 1`；review 文件落盘 |
| 8 | 连续 `needs_changes` 到 `maxReviewCycles` | 自动关门放行，review 文件里写明「已达上限」 |
| 9 | open feedback | `claim` 先返回 feedback packet；`plan_resolve` 后才轮到 block |
| 10 | 两 run 并发 `submit` | 两次更新都在；`state.json` 可解析 |
| 11 | 6 个工具 | 审批弹窗 0 次；只有 `plan_status` 是 `readOnly` |
| 12 | 无 workspace 会话 | 工具面里没有 `plan_*` |
| 13 | `plan.json` 被人为改坏 | 明确错误文案，聊天不卡死（契约 9） |
| 14 | `archive` | 目录 move 到 `plan-weave-archive/<ts>-<slug>`；原目录干净可重新 `create` |
| 15 | **移除实验**：去掉 per-workspace mutex | 用例 10 转红；恢复全绿 |

E2E：绑 workspace → 让模型把一个三步任务 `plan_create` 成任务图 → 连续 `claim/submit/review` 直到全 `done` → `git status` 里能看到 `.eva/plan-weave/` 的变更历史。

## 6. 坑

1. **`ready` 不是持久字段**。存了就会和人手改的 `plan.json` 打架；每次读写重算。
2. **mutex 不能省**（用例 10/15）。tmp+rename 只保证不读到半个文件。
3. **锁内不做慢活**。work packet 里若要塞上游报告全文，先在锁外读好。
4. **`owner` 要清干净**。block `done` / `reset` / `archive` 都必须清 `current`，否则任务图会永久 busy。
5. **`plan_status` 之外都不是 readOnly**。误标会被 T24 只读并发上限当只读放行，并发写就绕过了串行意图。
6. **路径拼接只有一处**（`paths.ts`）。工具、service、REST 各拼一次 = 迟早写到 workspace 外面去。
7. **`maxReviewCycles` 的自动关门要留痕**。悄悄放行会让人以为产出通过了 review。
8. **首版没有 WS 广播**（§2.7）。别在 REST 里顺手 emit per-run SSE —— plan 是 workspace 级，per-run 帧会漏给别的会话。
