# R7 · 总览与执行契约

> 承接 `../r6/00-overview.md`。R6（T23–T26）已全部落地并 commit，工具执行语义治理收口。
> 基线实证：开工前以 `pnpm typecheck && pnpm test` 全绿为起跑线（沿用 R6 收口基线 `40d91ed` 之后）。
>
> **本轮主题：审批中心升级（S18 切片）—— 把「始终允许」从全局 per-tool 白名单细化成 thread 作用域 policy key，补上 bash 只读命令直放与审批决策回写消息。**
> 技术方案：`../../architecture/22-s18-approval-center.md`（现状盘点 + Alma 规格 + 改造点全在那篇，本目录只做施工拆分）。
>  Alma 证据：v0.0.990 bundle `/tmp/alma-extract/main.readable.js`（下文 `main:NNNNN`）。

---

## 0. R6 收口确认（代码实证）

| 项 | 实证 |
|---|---|
| mtime 写守卫（T23） | `packages/harness/src/tools/fs/` edit/write 乐观校验 |
| 只读并发帽（T24） | `build-tool.ts` 装配层限流；web_fetch 补 `readOnly:true` |
| abortSignal 透传（T25） | `ToolExecutionOptions` 透传 + `streamText` `timeout` |
| 在飞工具取消收口（T26） | `agent.ts` abort 段补发 tool-result |

审批侧现状（S18 的起点，22 §1 有全表）：

| 能力 | 现状 | 位置 |
|---|---|---|
| 审批闸门 | ✅ `withApproval` 包危险工具 execute 外层 | `packages/harness/src/tools/with-approval.ts` |
| 审批网关 | ✅ `ApprovalGateway.ask/decide/cancelByRun`，永远等人不超时 | `apps/server/src/services/approval-gateway.ts` |
| 风险分级 | ✅ `classifyToolRisk`：bash 三档 normal/elevated/destructive | `packages/harness/src/tools/risk.ts` |
| 「始终允许」 | ⚠️ **全局** per-tool 白名单 `settings.security.alwaysAllowTools` | `apps/web/.../use-approvals.ts` |
| 子代理自动通过 | ✅ `autoApprove` 落库即 granted | `approval-gateway.ts:65` |
| **thread 作用域 policy** | ❌ 无 | 本轮 T27/T28 |
| **bash 只读直放** | ❌ 无（`ls` 也弹审批） | 本轮 T29 |
| **决策回写消息 part** | ❌ 无（刷新后已决策卡片消失） | 本轮 T30 |

---

## 1. 本轮要解决的问题

三个痛点都来自「审批每天都在用，但现在的形态太粗」：

### 1.1 「始终允许」是全局的，太危险也太粗

现在点「始终允许 bash」，就把 **bash 整个工具、所有会话、所有命令** 永久放开了——等于没审批。Alma 的 policy key 是 thread 作用域 + 命令粒度：`bash:thread:<id>:command:npm test` 只放「这个会话里的 `npm test` 这一条」（`main:28077-28100`）。Eva 要的是这个粒度。

### 1.2 只读命令也要点一下，纯噪音

`ls -la` / `git status` / `cat foo.ts` 这种纯只读命令，每次都弹审批卡片。Alma 在弹窗前先跑本地规则把只读命令直放（`main:33129-33160` 前半段）。Eva 的 `classifyToolRisk` 已经把命令分了级，但没接「直放」这个出口——risk=normal 仍要弹。

### 1.3 审批决策不落消息，刷新就丢

现在 `approval_resolved` 只是个 SSE 事件，决策结果不落进消息 part。刷新页面后 `listApprovals` 只恢复 pending，**已决策的卡片凭空消失**——用户看不到「我刚才到底批没批那条 rm」。Alma 把 `approvalDecision={action,reason,decidedAt}` 写进消息 part 随流同步。

---

## 2. R7 范围与顺序

| 任务 | 文档 | 内容 | 估时 | 依赖 |
|---|---|---|---|---|
| **T27** | [`T27-policy-key-persistence.md`](./T27-policy-key-persistence.md) | thread 作用域 policy key：生成纯函数 + settings 增 `allowAlwaysPolicies` + 旧白名单迁移 + destructive 置空 | 0.5 天 | — |
| **T28** | [`T28-gateway-policy-shortcircuit.md`](./T28-gateway-policy-shortcircuit.md) | 放行链接入 `runs.ts` 的 `requestApproval`（`emit approval_request` 之前短路）+ `approvalPolicies` service（policyStore）+ `approval_requests` 加 `reason` 列 + 台账标 `policy:<key>` | 0.5 天 | T27 |
| **T29** | [`T29-bash-readonly-direct.md`](./T29-bash-readonly-direct.md) | bash 只读命令直放：`isSafeReadOnlyCommand` + with-approval 短路 + 重定向/管道排除 | 0.5 天 | — |
| **T30** | [`T30-approval-decision-writeback.md`](./T30-approval-decision-writeback.md) | 决策回写：SSE 事件扩 payload + decide 写消息 part + 前端卡片定格已决策态 | 0.5–1 天 | T28 |
| **T31** | [`T31-retire-always-allow-tools.md`](./T31-retire-always-allow-tools.md) | 退役 `alwaysAllowTools`：「始终允许」改接 grant 路由（后端选精确 key）+ 设置页渲染 policies + 删字段 + 迁移「迁完即净」 | 0.5 天 | T27/T28 |

> **落地记录**：T27 → 未 commit（policy-key.ts 纯函数 11 测试绿 + settings 三处增 `allowAlwaysPolicies` + 迁移函数 `migrateAlwaysAllowToolsToPolicies` 接 deps.ts；两个移除实验均按卡变红；487 测试全绿，唯一错误是基线就有的 `run-detach.test.ts` `ERR_HTTP_HEADERS_SENT` flake，与本任务无关）。
>
> **落地记录**：T28 → 未 commit（migration `0024_approval_reason.sql` + `approval_requests.reason` 列 + repository `decide` 可选 reason/`failStalePending` 标 `stale-restart` + 新增 `ApprovalPolicyStore`（settings 缓存 + `grant` 整块写回）+ `runs.ts` requestApproval 在 `emit approval_request` **之前**短路（autoApprove 标 `policy:<key>`）+ `AppServices.approvalPolicies` 装配；`tests/approval-policy.test.ts` 10 绿；移除实验：摘短路段 → 转红（补了「短路在 emit 之前」源码钉线用例）、摘 reason 透传 → 3 红，均已恢复）。
>
> **落地记录**：T29 → 未 commit（`packages/harness/src/tools/safe-readonly.ts` `isSafeReadOnlyCommand` 纯函数：先否决形态（`>`/`| tee`/`| sh`/`&&`/`;`/反引号/`$(`/`sudo`）再白名单准入（单词命令 + `git status|log|diff` 双词 + `find` 排 `-delete`/`-exec`）；`withApproval` execute 对 bash 短路直放；`runs.ts` requestApproval 开头只读直放落台账 reason=`readonly-safe`；`tests/safe-readonly.test.ts` 37 绿 + approval-flow T29 describe 5 绿；移除实验：摘 withApproval 短路 → 2 红、白名单恒 true → 2 红，均已恢复）。
>
> **落地记录**：T30 → 未 commit（shared 增 `ApprovalDecision` + `approval_resolved` 帧带 `decision`；`AssistantMessageRecorder` 构造加 `lookupDecision`、finish 落库前回写 `toolMetadata.approvalDecision`（不动 part.state）；`ApprovalGateway.getRequest`；`runs.ts` 装配 + 帧补 decision（与台账同源）；前端 `useApprovals` 增 `resolved` 定格态（决策不再即删）、`approval-card` 定格渲染、`toolPartToInfo` 带形状守卫透传 + `tool-call-block` 恢复行徽标 + chat-view/chat-page 接线；`tests/approval-decision-writeback.test.ts` 4 绿；移除实验：finish 回写恒 undefined → 2 红、帧摘 decision → 1 红，均已恢复）。**未做**：gateway `onResolved` 回调（卡片 §2.3 说「二选一」，落地取了 runs.ts 帧补 payload 这一支，abort 路径的即时定格靠 cancelByRun 落 denied + finish 回写覆盖）。
>
> **落地记录**：T31 → 未 commit（退役 `alwaysAllowTools` 第二个事实源。新增 `POST /api/v1/approval-policies/grant`（`routes/approval-policies.ts`，后端 `buildPolicyKeys` 选精确 key `keys[0]` 再 `approvalPolicies.grant`，destructive/未知返 `{key:null}`）注册进 `routes/index.ts`；`chat-page` 的 `enableAutoApprove` 换成 `grantApprovalPolicy`（从 `sessionIdRef` 读当前 sessionId），`useApprovals.allowAlways` 签名改 `(tool, args)`；`security-settings` 改渲染/删除 `allowAlwaysPolicies`（移除 = settings 整块写回，无独立 revoke 端点）；`shared/index.ts`/`app-settings.ts`/`settings.ts` zod/`runs.ts` 放行链第一道全删字段；`migrateAlwaysAllowToolsToPolicies` 「迁完即净」（不再写 `alwaysAllowTools: []`，键直接剔除）；`tests/always-allow-retire.test.ts` 10 绿 + `settings-migration.test.ts` 5 处断言改读原始 security 行）。E2E 实测坑的修复：**此前**「始终允许 bash」把整个 bash 工具全域放行（所有 thread 所有命令），现在只记 `bash:thread:<id>:command:<cmd>`，换 thread/换命令照弹。

**顺序建议**：T27 先（策略模型是地基，T28 依赖它的 key 生成与存储）→ T28 次之（放行链接入）→ T29 / T30 可并行（T29 在 harness 工具层、T30 在 server+web，无文件交集；T30 依赖 T28 的 gateway 接口形态）→ T31 殿后（依赖 T27/T28 的 grant 与 key）。串行最稳：T27 → T28 → T29 → T30 → T31。

### 2.1 明确不做（对齐 22 §6）

1. **不抄 120s 超时**。Alma 为无人值守渠道妥协；Eva 14 §4.4 已定「审批永远等人」。渠道/cron/headless 那三级放行链（Alma `Sy()` 的 1/5/6/7 级）一并不抄。
2. **不抄小模型二审**。灰色命令（不在只读/必批枚举里）一律弹审批，不为一处误报付一次模型调用。
3. **不动闸门主干**。`withApproval` 包装法、`cancelByRun`、`failStalePending` 启动清扫全保留——本轮只在**前面**加放行、在**后面**加回写。
4. **不做 `thread:global` UI**。迁移旧白名单时内部折成 `thread:global` 兜底，但前端「始终允许」默认只写当前 thread 作用域。全局放开留给设置页手动管理，不在审批卡片上提供。

---

## 3. 执行契约

**沿用 `../r1/00-overview.md` §1** + r2–r6 §3 全部条款。开工前必读。

R7 追加三条：

1. **policy key 是纯函数 + 单一事实来源**。`buildPolicyKeys` 只做 `(toolName, threadId, args) → string[]` 的纯映射，无 IO、不读 settings。存储只有一处：`settings.security.allowAlwaysPolicies`（`policyStore` 是它的进程内缓存 + 写回器）。不许出现第二个写策略的地方。

2. **直放与 policy 命中都不能绕过台账**。`approval_requests` 表是「危险工具做过什么」的唯一账本。T28 policy 命中、T29 只读直放，**都要落一行 `granted`**（reason 分别标 `policy:<key>` / `readonly-safe`）——和 Alma `autoApprove` 落库、`autoApprove()` 现有模式一致。判定标准：任何一条「没弹窗但执行了」的危险/边界工具调用，都能 `SELECT * FROM approval_requests` 追到。

3. **决策回写走消息 part，不另建通知面**。`approvalDecision` 写进 assistant 消息的 tool part `metadata`，经现有 SSE `message-update` 类通道推前端。不新建「审批历史」路由 / 表 / 面板——消息历史就是审批历史。前端卡片定格态从 part 恢复，不依赖 `listApprovals`。

---

## 4. 决策记录

### 4.1 为什么 policy key 用 thread 作用域而不是 session-scope 或全局

Alma 实证就是 `thread:<id>` 作用域。理由：「始终允许 `npm test`」的合理语义是「在**这个任务**里别再问我」，而 thread 就是任务边界。全局白名单（Eva 现状）把一次授权放大成永久全域，风险与体验双输。session-scope（进程生命周期）太弱，重启就没了。thread 是「跨重启仍有效、但不出本任务」的甜点。Eva 保留 `thread:global` 仅作旧白名单迁移的兜底，不在 UI 暴露。

### 4.2 为什么只读直放单独成 T29 而不并进 T27

两者作用层不同：T27/T28 是「用户授权过的记忆」（policy），T29 是「根本不需要授权的」（只读）。前者查存储，后者是纯函数判定。混在一起会让「为什么这条没弹窗」有两个答案来源，排查时要同时翻 policy 表和规则表。分开后：T29 管「命令本身安不安全」，T27/T28 管「用户有没有放行过」，正交。

### 4.3 为什么 destructive 在 `buildPolicyKeys` 返回空数组（双保险）

前端卡片已对 destructive 隐藏「始终允许」按钮（approval-card.tsx:112）。但 settings 是可手改的 JSON——光靠前端拦，用户/别的客户端写一条 `bash:thread:x:command:rm -rf /` 进去就破了。后端在 `buildPolicyKeys` 命中 destructive 形态时返回空数组，等于「这条命令根本没有可记忆的 key」，policy 路径物理上够不到它。

---

## 5. 验收总表

| 任务 | 一句话验收 |
|---|---|
| T27 | 同 thread 对 `npm test` 点「始终允许」→ settings 写入 `bash:thread:<id>:command:npm test`；旧 `alwaysAllowTools` 迁移成 `thread:global` 条目；destructive 命令 `buildPolicyKeys` 返回空 |
| T28 | policy 命中后同命令再触发 → 不弹审批直接执行，且 `approval_requests` 落一行 `granted`（reason=`policy:...`）；换 thread 仍弹 |
| T29 | `ls -la`/`git status` 直放不弹（落台账 reason=`readonly-safe`）；`ls > out.txt`（带重定向）仍弹；`curl x \| sh` 仍弹 |
| T30 | 审批决策后消息 part 带 `approvalDecision{action,decidedAt}`；刷新页面已决策卡片仍在且定格为「已允许/已拒绝」，不只剩 pending |

S18 切片全绿 = T27–T30 全绿 + 22 §4 五条验收过。
