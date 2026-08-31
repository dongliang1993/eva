# T28 · 放行链接入 ApprovalGateway.ask：policyStore 前置查询 + 台账 reason 标注

> 依赖 **T27**（用它的 `buildPolicyKeys` 纯函数与 `settings.security.allowAlwaysPolicies` 存储，契约见 `00-overview.md` §3.1）。
> 前置阅读：`00-overview.md` §2.1（不抄超时/不抄渠道那几级）、§3.1–3.2（key 单一事实来源、命中也要落台账）；`docs/architecture/22-s18-approval-center.md` §2.2、§3.2。
> Alma 证据：`main:27910-28140`（`Sy()` 放行链）、`main:28077-28100`（policy key 模板）。

T27 把「policy key 能生成、能存」立起来了，但**还没人查它** —— 危险工具走到闸门照样弹审批卡片。本任务把 T27 的产物接进 `ApprovalGateway.ask`：落库 pending 之前先查一遍 policy 记忆，命中 `allow_always` 就短路放行（不发 `approval_request`、不进 pending Map、台账照记 `granted`），这是 Alma 放行链第 2 级（`main:28107-28113`）落到 Eva 的形态。同一张卡里带两件配套事：给 `approval_requests` 表加 `reason` 列（标明这次放行是 `policy:<key>` 还是用户手批）、新增 `policyStore` 作为 `allowAlwaysPolicies` 的进程内缓存 + 写回器（「始终允许」按钮未来的写入口）。

---

## 1. 问题

现状（T27 之后）：`settings.security.allowAlwaysPolicies` 里可能已经有 `bash:thread:<id>:command:npm test` 这样的 key，但 `ApprovalGateway.ask` 对它**无感知** —— `ask()` 的第一行就是 `repo.create(...)` 落 pending（`approval-gateway.ts:73`），然后挂进 `pending` Map 等用户点。policy 记忆成了死数据。

Eva 的放行链只有两级：T14 的全局 per-tool 白名单（`runs.ts:58` 的 `alwaysAllowTools.includes(toolName)`）+ T17 的子代理 `autoApprove`。中间缺的正是「这个 thread 里 `npm test` 已经批过一次了」这一级。

### 1.1 Alma 放行链里 Eva 只缺第 2 级

`Sy()`（`main:27910-28140`）按序短路，命中即返回 `{approved, action, reason}` 不再弹窗：

```
1. headless          ALMA_HEADLESS=1 → 直判          Eva 不做(无头场景)
2. allow_always 记忆  policy key 查中 → 直放          ← 本任务(Eva 缺的)
3. 全局 autoApprove   settings 核按钮 → 直放          Eva 已有(T14 白名单形态)
4. isSubagent        子代理 → 直放(落台账)           Eva 已有(autoApprove)
5-7. 渠道/cron/映射    无人值守通道                    Eva 不做(§2.1 #1)
```

### 1.2 短路点选 `ApprovalGateway.ask`，不是 `runs.ts` 的 `requestApproval`

这是本卡最容易放错位置的地方。`runs.ts:53` 的 `requestApproval` 是「先 `emit approval_request` 再 `ask`」：

```ts
// apps/server/src/routes/runs.ts:62-70 现状
const risk = classifyToolRisk(toolName, args);
emit({ type: "approval_request", callId: toolCallId, toolName, args, risk });
const approved = await app.services.approvals.ask(toolCallId, { runId, sessionId, tool: toolName, args });
emit({ type: "approval_resolved", callId: toolCallId, approved });
```

若短路放进 `ask()` 内部：policy 命中时 `ask` 立即 resolve，但 `approval_request` 帧**已经发出去了** —— 前端 `useApprovals.applyStreamEvent`（`use-approvals.ts:62`）会把这张卡片推进 pending 列表，然后收到紧跟的 `approval_resolved` 才移除。一张「其实根本没问过人」的卡片闪一帧，闪烁是小事，语义错了是大事（用户看到一张没人点的卡片被放行）。

**结论：policy 查询必须在 `emit approval_request` 之前完成，即短路点放在 `requestApproval` 里、`ask` 之前。** 22 §3.2 画的「`ask()` 开头新增」是简化示意；落到 Eva 的真实接线，`ask` 只负责「落 pending + 等人」这一件事，短路是调用方的事。`policyStore` 因此不嵌进 `ApprovalGateway`，而是独立服务（`app.services` 增一格），`requestApproval` 依次调：T14 白名单 → **policy 短路（新）** → `ask`（弹审批）。

### 1.3 台账要能回答「这次谁批的」

`approval_requests` 现在的行只能区分 pending/granted/denied（`schema.ts:271`，无 reason 列）。T28 之后「没弹窗但执行了」会多一个来源（policy 命中），后续 T29 还会再来一个（`readonly-safe`）—— 不加 reason 列，事后 `SELECT` 只能看到 granted，分不清是用户点的还是 policy 放的。r5 §3.1 的「不加冗余列」结论当时成立（子代理能 JOIN `background_tasks` 区分），但 policy 命中没有对应的 background_tasks 行，**分不出来就是台账失信**。本任务加列。

---

## 2. 改动

### 2.1 `approval_requests` 加 `reason` 列

migration `0024_approval_reason.sql`：`ALTER TABLE approval_requests ADD COLUMN reason text;`（`-->` statement-breakpoint 收尾，登记 `meta/_journal.json` idx 24）。

- `schema.ts:263-284` 表定义加 `reason: text("reason")`。
- `ApprovalRepository`（`approval-repository.ts`）：
  - `decide(id, status, reason?)` —— 第三参数可选，`undefined` 则不动该列（保留 T14 白名单/手动决策的现状行为）。
  - `ApprovalRequestRow` 增 `reason: string | null`；`CreateApprovalInput` 不动（reason 是决策时的产物，不是创建时的）。
  - `failStalePending` 顺带把收成 denied 的行写 `reason: "stale-restart"` —— 不然「重启清扫」和「用户拒绝」也分不开。

### 2.2 `policyStore`：`allowAlwaysPolicies` 的进程内缓存 + 写回器

新增 `apps/server/src/services/approval-policy-store.ts`，导出 `ApprovalPolicyStore`：

```ts
export class ApprovalPolicyStore {
  /** 启动时读一次 settings 进内存 Set;此后查询零 IO。 */
  constructor(db: AppDatabase, config: AppConfig);

  /** 命中返回那条 key,未命中返回 null。key 生成走 T27 的 buildPolicyKeys(纯函数)。 */
  match(tool: string, sessionId: string, args: unknown): string | null;

  /** 「始终允许」写回:把 key 追加进 settings.security.allowAlwaysPolicies 并刷新内存。 */
  grant(key: string): void;
}
```

- **单一事实来源是 settings 表**（`00-overview.md` §3.1）。`match` 只读内存 Set；`grant` 的写回走 `loadAppSettings`/`replaceAppSettings`（`app-settings.ts:62/111`）—— 注意 `replaceAppSettings` 是「先 `db.delete(settings)` 再整块重写」，`grant` 必须先读全量、append、再整块写回，**不能**只 update `security` 这一块（会把 models/chat/memory 三块删空）。参考 `chat-page.tsx:35` 的 `saveSettings` 同款 spread 模式。
- `match` 内部就是 `buildPolicyKeys({ toolName, threadId: sessionId, args })` 的每个 key 查一次内存 Set，命中即返回（精确 key 在前的顺序由 T27 保证）。
- **「存在即 allow_always」**：这点 Eva 与 Alma 同构 —— Alma 也是 `by = new Set()`（`main:27876`）装 key、命中即放，不是 key→value 映射。Eva 的 `allowAlwaysPolicies: string[]` 同义。`match` 命中返回 key 本身（给台账 reason 用），不返回值。

### 2.3 `requestApproval` 接线：`runs.ts` 短路

`apps/server/src/routes/runs.ts` 的 `requestApproval`（`runs.ts:53`）在 T14 白名单判断后、`emit approval_request` 前插入：

```ts
// T28:policy 记忆短路(Alma 放行链第 2 级)。命中 = 落台账 granted + 直放,不弹卡片。
const hit = app.services.approvalPolicies.match(toolName, sessionId, args);
if (hit) {
  app.services.approvals.autoApprove(toolCallId, { runId, sessionId, tool: toolName, args }, `policy:${hit}`);
  return true;
}
```

复用 `autoApprove` 的落库形态（`approval-gateway.ts:65`），给它加可选第三参 `reason` 透传进 `repo.decide`：policy 命中标 `policy:<key>`；子代理路径（`runs.ts:78`）不传 → 保持现状（NULL，区分得开）。`autoApprove` 不发 `approval_request`、不进 pending Map 的既有语义正好就是短路要的。

### 2.4 装配

`services/index.ts` 的 `buildAppServices` 增一行 `approvalPolicies: new ApprovalPolicyStore(infra.db, infra.config)`；`types/common.ts` 的 `AppServices`（`common.ts:32`）加 `approvalPolicies: ApprovalPolicyStore`。T30 的「始终允许」按钮会调 `approvalPolicies.grant(key)`（本卡不做 UI）。

---

## 3. 涉及文件

### 修改

| 文件 | 动作 |
|---|---|
| `apps/server/src/db/schema.ts` | `approvalRequests` 加 `reason: text("reason")` |
| `apps/server/src/db/repositories/approval-repository.ts` | `decide` 加可选 `reason`；`ApprovalRequestRow` 加 `reason`；`failStalePending` 写 `stale-restart` |
| `apps/server/src/services/approval-gateway.ts` | `autoApprove` 加可选 `reason` 透传 |
| `apps/server/src/routes/runs.ts` | `requestApproval` 插 policy 短路（§2.3） |
| `apps/server/src/services/index.ts` | 装配 `approvalPolicies` |
| `apps/server/src/types/common.ts` | `AppServices` 加 `approvalPolicies` 字段 |
| `apps/server/src/db/migrations/meta/_journal.json` | 登记 idx 24 |

### 新增

| 文件 | 动作 |
|---|---|
| `apps/server/src/services/approval-policy-store.ts` | `ApprovalPolicyStore`（§2.2） |
| `apps/server/src/db/migrations/0024_approval_reason.sql` | `ALTER TABLE ... ADD COLUMN reason` |
| `tests/approval-policy.test.ts` | §4 全部用例 |

---

## 4. 步骤

### Step 1 ·【测试先行】短路 + 台账（RED）

`tests/approval-policy.test.ts`（新建，复用 `approval-flow.test.ts:206` 的 in-memory db 模式）：

- **命中即直放**：内存 settings 写入 `allowAlwaysPolicies: ["bash:thread:s-1:command:npm test"]`；构造 `ApprovalPolicyStore` + 模拟 `requestApproval` 的调用序（先 match 后 ask）→ 断言 `match` 返回该 key、`autoApprove` 落库后 `approval_requests` 有 `granted` 行且 `reason = "policy:bash:thread:s-1:command:npm test"`、**`ask` 未被调**（spy 断言，`pending` Map 为空）。
- **换 thread 不命中**：同一 policy，`match("bash", "s-2", {command:"npm test"})` 返回 `null`。
- **未命中走 pending**：`match` 返回 `null` 时 `ask` 正常落 pending（现有 `cancelByRun` 用例回归不破）。

### Step 2 ·【测试先行】reason 列 + failStalePending（RED）

- `decide("c1", "granted", "policy:x")` 后 `getById("c1").reason === "policy:x"`；不传 reason 的 `decide` 保持 `reason === null`。
- `failStalePending` 把 pending 收成 denied 且 `reason === "stale-restart"`；已决策行的 reason 不被覆盖（`approval-flow.test.ts:306` 的用例扩断言）。

### Step 3 ·【测试先行】grant 写回不炸 settings（RED）

- `grant("bash:thread:s-1:all")` 后 `loadAppSettings` 读回 `allowAlwaysPolicies` 含该 key，且 `models`/`chat`/`memory` 三块**原样还在**（钉死 §2.2 的整块重写坑）；重复 `grant` 同一 key 幂等（Set 去重）。

### Step 4 · 实现（GREEN）

按 §2 落地：先 migration + schema + repository（Step 2 转绿），再 `ApprovalPolicyStore`（Step 3 转绿），最后 `runs.ts` 接线（Step 1 转绿）。`pnpm typecheck && pnpm test` 全绿。

---

## 5. 验收

| # | 验收 | 判定 |
|---|---|---|
| 1 | 同 thread 对已记忆的 `npm test` 再触发 → 不发 `approval_request`、不进 pending，直接执行 | 测：`ask` spy 未调、`pending` 为空；E2E：点过一次「始终允许」后同命令不再弹卡片 |
| 2 | policy 命中落台账：`approval_requests` 一行 `granted`，`reason = policy:<key>` | `SELECT reason FROM approval_requests WHERE id=...` |
| 3 | 换 thread 仍弹审批（policy 不跨会话泄漏） | `match` 对别的 sessionId 返回 `null`，`ask` 正常走 pending |
| 4 | `failStalePending` 收的行 `reason = stale-restart`，用户手批的行 `reason` 为 NULL | migration 后重启一次验证 |
| 5 | **移除实验**：注释掉 `runs.ts` 的短路段（§2.3）→ 用例 1 转红（`ask` 被调、落 pending 而非 granted） | 证明测试真的在守短路逻辑 |
| 6 | **移除实验**：摘掉 `autoApprove` 的 reason 透传 → 用例 2 转红（reason 变 NULL） | 证明台账标注在守 |

E2E（页面，依赖 T30 的 UI 才完整）：当前可用 `sqlite3 ~/.eva/eva.db "select id, tool, status, reason from approval_requests order by rowid desc limit 5"` 直接验证台账形态。

---

## 6. 坑

按踩中概率排序：

1. **短路点放错位置（最高危）**。照抄 22 §3.2 的「`ask()` 开头插一道」会让 policy 命中的调用也先发一帧 `approval_request`（§1.2）—— 前端卡片闪一帧再消失，「没弹窗但执行了」变成「弹了一瞬又自己批了」。短路必须在 `emit approval_request` **之前**，即 `runs.ts` 的 `requestApproval` 里。测试用「`approval_request` 帧数 === 0」断言钉死，不是只断言「`ask` 没被调」（`ask` 不被调不代表卡片没闪）。
2. **`replaceAppSettings` 是先 delete 全表再整块重写**。`grant` 若图省事只 update `security` 这一块，会把 models/chat/memory 三块删成默认值 —— 用户在设置页配的模型全没了。必须先 `loadAppSettings` 读全量、spread 改 `security.allowAlwaysPolicies`、再 `replaceAppSettings` 整块写回（`chat-page.tsx:35` 同款）。Step 3 的用例专门钉这个。
3. **`reason` 别塞进 `CreateApprovalInput`**。reason 是**决策时**的产物（`policy:` / `stale-restart` / 未来的 `readonly-safe`），创建 pending 行时还不知道。塞进 create 会导致 policy 命中路径要先 create 带个假 reason 再 decide 覆盖 —— 两道写、且中间态的 reason 是错的。正确形态：create 不写 reason，`decide` 的可选第三参负责。
4. **migration 编号与 journal 登记**。下一个是 `0024_approval_reason.sql`，`meta/_journal.json` 加 idx 24 的 entry（`when` 用当前毫秒时间戳，`breakpoints: true`）。漏登记 journal → drizzle 不认这条 migration → `migrateDb` 跳过 → 测试里 `reason` 列不存在直接炸。现有 `approval-flow.test.ts` 的 in-memory `migrateDb` 会替你暴露这个错。
5. **子代理路径不传 reason 是刻意的**。`subagentRequestApproval`（`runs.ts:78`）也走 `autoApprove`，但它的 reason 保持 NULL —— 「子代理自动通过」和「policy 命中」在台账里靠 `reason IS NULL` vs `reason LIKE 'policy:%'` 区分。别顺手给子代理也标一个 `auto`：r5 §3.1 的结论是子代理靠 `background_tasks` JOIN 区分，标了反而和 r5 的判定标准（`granted(auto)` 靠 JOIN）打架。
6. **`autoApprove` 加参数别破坏现有调用**。`runs.ts:78` 与 `tests/subagent-approval.test.ts` 都在调 `autoApprove(callId, input)` 两参形态 —— reason 必须是**可选第三参**，不是改签名。改成必传会一次性炸掉所有子代理测试。
