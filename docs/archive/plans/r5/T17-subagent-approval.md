# T17 · 审批矩阵：isSubagent 自动通过分支

> 前置：无。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §1.2、§3。
> 施工图：`docs/architecture/04-model-adapter-agent-harness.md` §8.6.1（六分支决策树）+ §5.1（信任模型）。

**建议 1 个 commit**：`fix(server)` —— 这是 R4 子代理体系的补丁，不是新 feature。

---

## 1. 问题实证

### 1.1 死法：子代理的危险工具调用无人可批

`docs 04 §8.6.1` 的 Alma 审批决策树，分支 2 原文：

```js
// 分支 2：子代理（Task 工具 spawn 的）→ 自动通过
if (req.metadata?.isSubagent === true)
  return { requestId: oy(), approved: true, reason: "approved", action: "allow_once" };
```

设计意图（同节）："子代理、cron、跨平台频道**没人能点弹窗** → 必须自动通过，否则永远卡住。"

Eva 现状（R4 之后）：

```
subagent-runner.ts:160   this.agents.buildSubagent({ role, ... })      ← 不传 requestApproval
agent-factory.ts:319     createAgent({ model, tools, ..., observer })   ← 无 requestApproval
create-agent.ts:11       requestApproval ? wrap : rest.tools            ← 不包 withApproval
```

后果链：

1. **现在**：三个内置角色（explorer/researcher/reviewer）全是只读白名单（`crew.ts`），没有 `requiresApproval: true` 的工具 —— 问题潜伏。
2. **将来**：任何给角色开写工具的尝试（T15 §6 坑 5 预告过这个需求），写工具会以**裸奔**状态执行 —— 没有审批、没有记录、没有风险画像。这比 Alma 分支缺失的"卡住"更糟：Alma 缺这个分支是死锁，Eva 缺这个分支是**无闸**。

### 1.2 为什么不能维持"不包"现状

两条路都不对：

- **不包 `withApproval`（现状）** = 危险工具在子代理里无条件执行。审批体系（T14 建的 per-tool 风险分级 + `approval_requests` 落库）对子代理整体失效。
- **包同一个 `requestApproval`** = `runs.ts:60` 的 `approvals.ask(...)` 会 `emit approval_request` 然后等前端 `decide`。子代理的工具调用发生在后台 loop 里，前端能看到卡片但**语义错误**：用户批的是"主 agent 要做 X"，卡片却从子代理的上下文里冒出来（`runId` 相同、`toolCallId` 陌生）；而且后台子代理在 NOTICE_GRACE_MS 窗口外才跑完时，审批卡片到达时主 SSE 流已关闭，用户点了也没人能收到 —— **挂到 5 分钟超时自动 deny**（`PENDING_TIMEOUT_MS`）。

正确形态就是 Alma 那条分支：**子代理进闸门，闸门里第一个分支放行，记录照落**。

---

## 2. 目标设计

### 2.1 决策矩阵落到 Eva 的注入点

Alma 的矩阵在一个全局 `requestToolApproval(req)` 函数里按 `req.metadata` 分支。Eva 的等价注入点是 `RequestApproval`（`packages/harness/src/agents/types.ts:64`）—— 每个 agent 装配时注入一个。矩阵因此**不需要 metadata 字段**，直接在装配期决定给哪个分支：

```
主 agent（routes/runs.ts）          子代理（subagent-runner.ts）
requestApproval = async (req) => {   requestApproval = async (req) => {
  // 分支 1: per-tool 白名单            // 分支 0(新): isSubagent → 自动通过,落库
  if (alwaysAllow) return true;         await approvals.askAutoApproved(callId, {...});
  // 分支 2: 弹审批卡片                  return true;
  emit(approval_request);            }
  return approvals.ask(...);
}
```

**关键：子代理也走 `approvals`，只是走"自动批准"那一格。** 落库一行 `approval_requests`（status 直接 `granted`），风险画像照算 —— 事后追溯"这个子代理写过什么"与追溯主 agent 用同一张表。

### 2.2 `ApprovalGateway` 加 `askAutoApproved`

`approval-gateway.ts` 现状只有 `ask()`（落 pending + 等 decide）。加：

```ts
/**
 * 子代理的自动通过分支(docs 04 §8.6.1 分支 2)。
 * 与 ask() 的唯一区别:不等用户 —— 落库即 granted,返回 true。
 * 仍然落库:审批表是"危险工具做过什么"的唯一台账,自动通过也必须可追溯。
 * 不进 pending Map:没有待决态,cancelByRun 自然碰不到它。
 */
autoApprove(callId: string, input: ApprovalAskInput): boolean {
  this.repo.create({ id: callId, ...input });
  this.repo.decide(callId, "granted");
  return true;
}
```

`ApprovalRepository.decide` 已存在（`ask()` 的超时路径在用），无需改 DB。`approval_requests` 表的 status 枚举已有 `granted/denied`，**不加新状态值** —— "auto" 的区分靠调用方在 `args` 之外的信息：子代理的工具调用 `parentToolCallId` 链在 `background_tasks` 表里，事后 JOIN 就能分出"这条 granted 是子代理的"。不为可追溯性再加冗余列。

### 2.3 `buildSubagent` 接受并注入 `requestApproval`

`agent-factory.ts` 的 `buildSubagent(options)` 加可选字段 `requestApproval?: RequestApproval`，透传给 `createAgent`（`create-agent.ts:11` 的既有分支自动包上 `withApproval`）。

`subagent-runner.ts` 的 `SubagentRunnerOptions` 加 `requestApproval?: RequestApproval`；`runFork`/`spawnSettled` 里把它传进 `buildSubagent`。

**谁构造子代理版的 requestApproval**：`routes/runs.ts` —— 主 agent 的 `requestApproval` 闭包旁边，派生一个子代理版：

```ts
// 子代理分支(docs 04 §8.6.1):没人能点弹窗,自动通过 —— 但照落审批台账。
const subagentRequestApproval: RequestApproval = async ({ toolCallId, toolName, args }) =>
  app.services.approvals.autoApprove(toolCallId, { runId, sessionId, tool: toolName, args });
```

传给 `SubagentRunner`（构造处就在同一个路由里）。

### 2.4 审批卡片不弹

`autoApprove` 不 `emit approval_request` —— SSE 那侧无感知，前端无卡片。这正是矩阵的语义："谁在场"决定弹不弹。台账在 DB 里，不在流里。

### 2.5 内置角色维持只读

本任务**不给任何现有角色加写工具**。验收用一个测试专用角色（见 §4 Step 3）证明"有写工具的子代理能过闸"。给 explorer 真开写工具是另一个决策（per-path 锁，T15 §6 坑 5），不在本轮。

---

## 3. 涉及文件

### 修改
| 文件 | 动作 |
|---|---|
| `apps/server/src/services/approval-gateway.ts` | 加 `autoApprove(callId, input)`（§2.2） |
| `apps/server/src/services/agent-factory.ts` | `buildSubagent` options 加 `requestApproval?`，透传 `createAgent` |
| `apps/server/src/services/subagents/subagent-runner.ts` | `SubagentRunnerOptions` 加 `requestApproval?`；`spawnSettled` 传进 `buildSubagent` |
| `apps/server/src/routes/runs.ts` | 派生 `subagentRequestApproval` 闭包，传给 `SubagentRunner` |
| `tests/subagent-approval.test.ts` | 新增（§4） |

### 新增
无（测试文件除外）。

---

## 4. 步骤

### Step 1 · 【测试先行】`autoApprove` 落库即 granted、不进 pending

`tests/subagent-approval.test.ts`（DB 照 `tests/agent-runtime.test.ts`：`initDb({dbPath:":memory:"})` + `migrateDb`）：

- `autoApprove("c1", {...})` 返回 `true`；
- `approval_requests` 表里 `c1` 这行 status = `granted`；
- `listPending()` **不含** `c1`（没有待决态）；
- `cancelByRun(runId)` 之后 `c1` 仍是 `granted`（自动通过的记录不被取消扫到）；
- 对照组：`ask()` 的 pending 记录 `cancelByRun` 后变 `denied`（既有行为回归）。

跑测试确认 **RED**（`autoApprove` 不存在）。

### Step 2 · `ApprovalGateway.autoApprove`

按 §2.2 实现。GREEN。

### Step 3 · 【测试先行】子代理危险工具过闸、主 agent 照弹

同一个测试文件，用 `MockLanguageModelV4` + `simulateReadableStream`（照 `tests/lead-agent-abort.test.ts` 搭法）：

- 装配一个带**测试专用写工具**（`requiresApproval: true`，execute 返回 "written"）的子代理，注入 `subagentRequestApproval`；
- 模型第一轮就调这个工具；
- 断言：工具 execute **被执行**（结果进流）；`approval_requests` 有一行 granted；**没有** `approval_request` SSE 事件发出（用 observer/事件收集断言）；
- 对照：同一工具在主 agent（注入 `runs.ts` 版 requestApproval、无白名单命中）→ 走 `ask()`，pending 出现。

搭这条测试时会发现 `buildSubagent` 目前不接 `requestApproval` —— 那就是 RED 的另一半。

### Step 4 · 接线

`agent-factory.ts` + `subagent-runner.ts` + `routes/runs.ts` 按 §2.3 穿透。`pnpm typecheck && pnpm test` 全绿。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；`tests/subagent-approval.test.ts` RED→GREEN
- [ ] 手工：构造带写工具的子代理（临时给 explorer 加 `write_file` 或注册测试角色）→ 子代理写文件成功，**主界面无审批卡片** → `sqlite3 ~/.eva/eva.db "select tool, status from approval_requests order by rowid desc limit 3"` 能看到自动 granted 的记录
- [ ] 手工回归：主线程让 agent 写文件 → 审批卡片照弹、批准后执行（T14 行为不变）
- [ ] `grep -n "requestApproval" apps/server/src/services/subagents/subagent-runner.ts apps/server/src/services/agent-factory.ts` 非零命中（穿透实证）

## 6. 坑

1. **把"自动通过"写成"不包 withApproval"**。这是本任务唯一的错法，也是现状。判定标准见 `00-overview.md` §3 R5-1：跑完子代理写操作后审批表里有没有那行 granted。
2. **`autoApprove` 里忘了 `repo.create`**。`decide` 依赖行已存在（UPDATE 语义）；不 create 就 decide 是静默 no-op，台账缺行。
3. **给子代理的闭包里复用主 agent 的 `emit`**。`subagentRequestApproval` 不许 `emit approval_request` —— 后台子代理的 SSE 帧会混进主流，前端冒出一个 runId 相同但 toolCallId 陌生的审批卡片。
4. **顺手给内置角色开写工具**。不在本任务范围（§2.5）；开了就得同时做 per-path 互斥锁（T15 §6 坑 5），半天任务变三天。
