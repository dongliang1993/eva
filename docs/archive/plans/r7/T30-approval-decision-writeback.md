# T30 · 审批决策回写消息 part

> 承接 T28（gateway decide 的接口形态）。T14 把审批做成了 SSE 事件 + 内存待决表：
> `approval_request` 弹卡片、用户点完 `approval_resolved` 把卡片从列表里删掉。但决策
> 结果**只活在 SSE 帧和 `approval_requests` 台账里，从不进消息 part** —— 刷新页面后
> `listApprovals` 只恢复 pending，已决策的卡片凭空消失，用户看不到「我刚才到底批没批
> 那条 `rm`」。Alma 把 `approvalDecision={action, reason, decidedAt}` 写进消息 part 随流
> 同步（`main:28718-28722` 构造、`main:28735` 挂到 toolExecutionResultCallback），决策
> 成为消息历史的一部分。本任务给 Eva 补上这一环：SSE 事件扩 payload、decision 落进
> tool part 的 `toolMetadata`、前端卡片决策后定格成「已允许/已拒绝 + 时间」并可从 part 恢复。

## 1. 问题

E2E 实测路径（现状代码逐行走过）：

1. `bash: rm -rf dist` 触发审批 → `requestApproval`（`runs.ts:53`）emit `approval_request`，
   `useApprovals.applyStreamEvent` 把它塞进 `pending`（`use-approvals.ts:60`），
   chat-view 把它渲染成独立卡片（`chat-view.tsx:71-79`）。
2. 用户点「允许一次」→ POST `/tool-approvals/:callId` → `gateway.decide`（`approval-gateway.ts:85`）
   `repo.decide(callId,"granted")` + `entry.resolve(true)`；前端 `decide()` 把这条从
   `pending` 里 `filter` 掉（`use-approvals.ts:43`）—— **卡片消失**。
3. 刷新页面 → `loadSession` 拉 `fetchThreadMessages`（历史消息里没有这条审批的痕迹），
   `approvals.refresh` 调 `listApprovals` 只回 pending（`approvals.ts:15-27`，内存 Map
   里已没有它）—— **已决策卡片两边都不恢复**。

| 面 | 现状 | 期望（对齐 Alma） |
| --- | --- | --- |
| 实时 | ✅ SSE 推 `approval_resolved{callId,approved}`，卡片消失 | 决策后卡片定格为「已允许/已拒绝+时间」 |
| 消息 part | 🔴 tool part 的 `toolMetadata` 只有 `durationMs`，无决策 | `toolMetadata.approvalDecision={action,decidedAt}` |
| 刷新恢复 | 🔴 只剩 pending，已决策凭空消失 | 从消息 part 恢复已决策定格态 |
| 台账 | ✅ `approval_requests` 有 `status+decidedAt` | 不变（本任务不碰台账结构） |

### 1.1 根因（三处断点，都已核实代码）

- **事件太薄**：`RunApprovalResolvedEvent` 只有 `{callId,approved}`（`stream-events.ts:162-166`），
  没有 `decidedAt`，前端定格态连「什么时候批的」都显示不出。
- **part 不写决策**：dynamic-tool part 的 `toolMetadata`（SDK 原生字段）现在只被
  `UiMessageBuilder.settleTool` 写 `durationMs`（`ui-message-builder.ts:167-189`），
  决策信息从没进过 part，落库的消息里自然没有。
- **卡片即抛**：`useApprovals` 把 `pending` 当唯一事实源，决策即 `filter` 删除；卡片渲染
  挂在 chat-view 的独立列表里，不挂在消息气泡上 —— 一旦从 `pending` 移除就再无着落。

### 1.2 时序约束（决定写入点，本任务最关键的架构事实）

decide 发生时，对应那条 assistant 消息**多半还没落库**：它在 `messageRecorder` 的在飞
`UiMessageBuilder` 里，要等 run 结束的 `messageRecorder.finish()`（`runs.ts:201`）才
`recordAssistantMessage` 落库。而 `ApprovalGateway` 是服务层单例，**拿不到路由闭包里的
messageRecorder**。所以「decide 时直接改 part」在结构上够不到 —— 写入点必须落在能同时
看到「decision 数据源」和「消息 part」的地方。

## 2. 改动

四处改动，沿着「事件 → 落库 → 推送 → 前端」一条链：

### 2.1 SSE 事件扩 payload（`packages/shared/src/stream-events.ts`）

`RunApprovalResolvedEvent` 增 `decision` 字段：

```ts
export interface ApprovalDecision {
  readonly action: "granted" | "denied";
  readonly decidedAt: string;  // ISO,与 approval_requests.decidedAt 同源
}

export interface RunApprovalResolvedEvent {
  type: "approval_resolved";
  callId: string;
  approved: boolean;             // 保留,前端兼容旧逻辑
  decision: ApprovalDecision;    // 新增
}
```

`ApprovalDecision` 类型也从 shared 导出（前端 `approval-card` 要消费）。

### 2.2 decision 落进消息 part（server，写入点选在 finish）

**决策数据源**：`ApprovalRepository.getById(callId)` 已返回 `{status, decidedAt}`
（`approval-repository.ts:45-64`），无需改表结构。

**写入点**：`AssistantMessageRecorder.finish()`（`assistant-message-recorder.ts:78`）在
`builder.build()` 之后、`recordAssistantMessage` 之前，遍历消息 parts，对每个
`isDynamicToolPart` 且能在 `approval_requests` 查到已决策行的 part，把
`toolMetadata.approvalDecision` 补进去。给 recorder 注入一个
`lookupDecision: (callId: string) => ApprovalDecision | undefined`（构造参数，由 runs.ts
用 `approvalRepository.getById` 适配）。part 更新是纯函数：
`{...part, toolMetadata: {...part.toolMetadata, approvalDecision}}`。

为什么不在 `decide()` 里写：见 §1.2 —— decide 时消息还在在飞 builder，gateway 够不到；
而 finish 时消息正要落库、`approval_requests` 行已 decided，是唯一「两边都齐」的点。
这同时**天然覆盖 cancelByRun**：abort 把 pending 收成 denied 同样走 `repo.decide`
（`approval-gateway.ts:110`），finish 时一并查回写，不需要给 cancelByRun 单独开路径。

> 注意 `autoApprove`（子代理）也走 `repo.decide`（`approval-gateway.ts:67`），finish 时会被
> 一并回写 —— 符合「台账即可追溯」的契约，不特殊处理。

### 2.3 decide 实时推前端（`approval-gateway.ts` + `runs.ts`）

`decide()`/`cancelByRun()` 在 `repo.decide` 后，把 `{callId, decision}` 经现有 SSE 桥
推给前端，让在看的用户即时看到定格。gateway 现在**不持有 emit**（emit 在 runs.ts 路由
闭包里）—— 给 `ApprovalGateway` 构造器注入一个
`onResolved?: (callId: string, decision: ApprovalDecision) => void` 回调，`decide` /
`cancelByRun` 的每个 resolve 点调用它；runs.ts 在 `requestApproval` 拿到 `approved` 后
已经 emit `approval_resolved`（`runs.ts:70`），把那帧的 payload 补上 `decision` 字段即可
（decision 从 gateway 同步返回 / 回调带出，二选一，实现时取改动更小的）。

> 契约红线（r7 §3.3）：decision 走消息 part + 现有 SSE 通道，**不新建**「审批历史」
> 路由/表/面板。方案 22 §3.4 说的「现有 message-update 类通道」实际并不存在（全仓 grep
> 无 `message-update`）—— 落地为「复用 `approval_resolved` 推实时态 + part 落库做持久」。

### 2.4 前端定格 + 恢复（web）

- **`use-approvals.ts`**：决策后不再 `filter` 删除，而是把这条从 `pending` 移入一个
  `resolved: Record<callId, ApprovalDecision>`（或并入消息流，见下）。`applyStreamEvent`
  的 `approval_resolved` 分支读 `event.decision` 记录定格态。
- **`approval-card.tsx`**：增 `resolved?: ApprovalDecision` prop。有 resolved 时渲染定格态
  （图标 + 「已允许/已拒绝 · HH:MM」），隐藏三个按钮；无 resolved 时维持现状。
- **刷新恢复**：定格态的事实源是**消息 part 的 `toolMetadata.approvalDecision`**，不是
  `listApprovals`（它只回 pending）。`message-bubble` 渲染 tool part 时已能拿到
  `toolMetadata` —— 已决策的 tool part 在气泡里补一行「已允许/已拒绝 · 时间」，
  刷新后随 `fetchThreadMessages` 自然回来。`useApprovals` 的 `resolved` 只覆盖「本次
  会话内、刚决策的那一张」的即时定格。

## 3. 涉及文件

修改：

- `packages/shared/src/stream-events.ts` —— `RunApprovalResolvedEvent` 扩 `decision`，
  新增 `ApprovalDecision`（`index.ts:289` 已 `export * from "./stream-events.js"`，自动 re-export，
  不用动 index）。
- `apps/server/src/services/runs/assistant-message-recorder.ts` —— 构造增 `lookupDecision`，
  `finish()` 回写 part `toolMetadata.approvalDecision`。
- `apps/server/src/services/approval-gateway.ts` —— 构造增 `onResolved` 回调；`decide()` /
  `cancelByRun()` 在 `repo.decide` 后触发。
- `apps/server/src/routes/runs.ts` —— 装配 `lookupDecision`（适配 `approvalRepository`）；
  `approval_resolved` 帧补 `decision` payload。
- `apps/web/src/features/threads/hooks/use-approvals.ts` —— 决策后记录定格态而非即删。
- `apps/web/src/features/threads/components/approval-card.tsx` —— 增 resolved 定格渲染。
- `apps/web/src/features/threads/components/message-bubble.tsx` —— tool part 带
  `approvalDecision` 时渲染已决策行（恢复路径）。

新增：

- `tests/approval-decision-writeback.test.ts` —— 见 §4。

不新增任何路由/表/前端面板（契约 §3.3）。

## 4. 步骤（测试先行）

1. **RED-1（落库回写）**：写 `tests/approval-decision-writeback.test.ts` 用例 —— 构造一个
   含 dynamic-tool part 的 `AssistantMessageRecorder`，`lookupDecision` 返回
   `{action:"granted",decidedAt:...}`，`finish()` 后断言落库消息的该 part
   `toolMetadata.approvalDecision` 等于它。此刻 `lookupDecision` 还不存在 → 编译/运行红。
2. **GREEN-1**：给 recorder 加 `lookupDecision` + finish 回写，用例转绿。
3. **RED-2（事件 payload）**：写用例断言 `approval_resolved` 帧带 `decision{action,decidedAt}`。
   此刻事件无 `decision` → 红。
4. **GREEN-2**：扩 `stream-events.ts` + gateway `onResolved` + runs.ts 补 payload，转绿。
5. **RED-3（cancelByRun 覆盖）**：用例 —— pending 审批被 `cancelByRun` 收 denied 后，
   finish 落库的 part 也带 `approvalDecision{action:"denied"}`。验证「cancelByRun 不开
   单独路径」的论断。
6. **GREEN-3**：若 RED-3 直接绿（设计如此），保留作回归；若红则补齐。
7. 前端：`approval-card` 定格态 + `message-bubble` part 恢复行，手动 E2E 验证（§5）。
8. `pnpm typecheck && pnpm test` 全绿。

## 5. 验收

| # | 用例 | 断言 |
| --- | --- | --- |
| 1 | 决策后消息 part 落库带决策 | 允许一条 bash 审批 → run 结束 → DB 里该 assistant 消息的 tool part `toolMetadata.approvalDecision = {action:"granted", decidedAt}` |
| 2 | SSE 帧带 decision | `approval_resolved` 帧 payload 含 `decision{action,decidedAt}`，且 `decidedAt` 与 `approval_requests.decidedAt` 一致 |
| 3 | abort 取消也回写 | pending 审批被 `cancelByRun` 收 denied → part 带 `{action:"denied"}`，无需单独路径 |
| 4 | 刷新后定格态仍在 | 决策后刷新页面 → 该工具卡片在消息流里显示「已允许/已拒绝 · 时间」，不是凭空消失，也不只剩 pending |
| 5 | 移除实验 | 摘掉 recorder 的 finish 回写段（或 `lookupDecision` 恒返 undefined）→ 用例 1、3 转红，证明测试在守这段逻辑 |
| 6 | 移除实验（事件） | 从 `approval_resolved` 帧摘掉 `decision` → 用例 2 转红 |
| 7 | autoApprove 不特殊炸 | 子代理自动通过的调用落库后 part 同样带 `granted`，不报错 |

## 6. 坑（按踩中概率排序）

1. **写入点选在 decide 是死路**。最直觉的改法是 `gateway.decide()` 里直接改 part —— 但
   decide 时消息还在在飞 `UiMessageBuilder`（`runs.ts:201` 才落库），gateway 是服务单例
   拿不到路由闭包里的 recorder。硬把它俩连起来会把服务层和路由层焊死。**写入点必须是
   finish 时查回写**，这是本任务最容易走错的一步。
2. **`toolMetadata` 类型是宽松 JSONValue**。SDK 的 dynamic-tool part `toolMetadata` 是
   `Record<string, JSONValue>` 类的宽松类型（`replay-events.ts:54` 已有「窄回 number」的
   注释）。写 `approvalDecision` 没问题，但**读端**（前端 part 恢复、`toolPartToInfo`）要做
   类型守卫，不能假设它一定是 `{action,decidedAt}` 形状 —— 否则历史脏数据/旧消息会让
   渲染炸掉。
3. **回放路径不带 decision**。`replayEventsFor`（`replay-events.ts`）把 part 反推成
   `tool-call`/`tool-result` 帧，**不回放 `approval_resolved`**（它是 Eva 自有域，不在
   `RunAgentStreamEvent` 里）。刷新后重连在飞 run 时，定格态要靠 part 里的
   `toolMetadata.approvalDecision` 恢复，不能指望事件重放 —— 这正是「事实源是 part 而非
   事件」的原因，前端两路（即时事件 + part 恢复）都要接。
4. **`decide` 与 `cancelByRun` 都要推**。只给 `decide` 加 `onResolved` 会漏掉 abort 路径：
   用户点停止时 pending 卡片也该定格成「已拒绝」，而不是悄悄消失。两个 resolve 点都要触发
   回调（`approval-gateway.ts:90-91` 与 `:109-111`）。
5. **不改变 part 的 state 语义**。决策信息只进 `toolMetadata`，**不动** part 的
   `state`（`input-available`/`output-available`/`output-error`）—— denied 的工具本来就会
   收到 `deniedMessage` 作为 output（`with-approval.ts:44-46`），part 会是 `output-available`。
   别为了让「被拒绝」显眼去改 state，那会污染 `convertToModelMessages` 的回灌语义。
6. **「始终允许」路径没有卡片也就没有定格**。T28 policy 命中 / T29 只读直放根本不弹审批
   （不 emit `approval_request`），自然没有待定格的卡片 —— 它们的追溯走 `approval_requests`
   台账（reason 标注），不走前端卡片。本任务不管这条，别给它俩补「虚拟卡片」。
