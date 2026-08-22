# 22 · S18 审批中心升级：技术方案

> 切片编号 S18，来源 11 §3.5。前置阅读：14 §4.4（审批闸门）、04 修订框（Alma `Sy()` 审批中心规格）、16 §3.1-3（取舍边界）。
> 证据约定：`main:NNNNN` = Alma v0.0.990 bundle `/tmp/alma-extract/main.readable.js` 行号；`eva:` = 本仓库文件。

## 0. 一句话

把 Eva 现有的「全局 per-tool 白名单」审批，升级为 Alma 的 **thread 作用域 policy key** 形态，并补上 **bash 安全命令直放** 与 **审批决策回写消息**。三件套都抄 Alma，但**坚决不抄 Alma 的 120s 超时**（14 §4.4 已定「永远等人」）。

## 1. 现状盘点（代码实证，避免方案落空）

S18 不是从零建。Eva 已有的地基比 11 篇 §3.5 写的更全：

| 能力 | 现状 | 位置 |
|---|---|---|
| 审批闸门 | ✅ `withApproval` 高阶函数包危险工具 execute 外层；`needsApproval!==true` 直接放行 | `eva:packages/harness/src/tools/with-approval.ts` |
| 审批网关 | ✅ `ApprovalGateway.ask/decide/cancelByRun`，永远等人不超时，落库 `approval_requests` | `eva:apps/server/src/services/approval-gateway.ts` |
| 风险分级 | ✅ `classifyToolRisk`：bash 三档（normal/elevated/destructive），正则匹配形态 | `eva:packages/harness/src/tools/risk.ts` |
| 「始终允许」 | ⚠️ 已有，但是**全局 per-tool 白名单** `settings.security.alwaysAllowTools: string[]`（T14） | `eva:apps/web/.../use-approvals.ts` `allowAlways()` |
| destructive 不给始终允许 | ✅ 前端卡片已拦截 | `eva:apps/web/.../approval-card.tsx:112` |
| 子代理自动通过 | ✅ `ApprovalGateway.autoApprove` 落库即 granted | `eva:apps/server/src/services/approval-gateway.ts:65` |
| 决策回写消息 part | ❌ 无。SSE 只推 `approval_request/approval_resolved`，不落进消息 part，刷新后看不到「当时批没批」 | — |
| thread 作用域 policy | ❌ 无。白名单是全局的，「这个 thread 里始终允许 `npm test`」做不到 | — |
| bash 安全直放 | ❌ 无。`ls`/`cat` 也要点一下（虽然 risk=elevated 但仍需审批） | — |

**结论：S18 是把「始终允许」从全局 per-tool 细化成 thread 作用域 policy key + 加直放 + 加回写，三处都是增量，不动闸门主干。**

## 2. Alma 规格（v0.0.990 实证）

### 2.1 policy key 模板（`main:28077-28100` 还原）

Alma 的 `Sy()` 在自动放行链末尾查 policy key。key 由 `(source, threadId, metadata)` 三元组生成：

```ts
// main:28077-28100 还原
const scope = threadId ? `thread:${threadId}` : "thread:global";
const keys: string[] = [];
if (source === "bash") {
  const cmd = (metadata?.command ?? "").trim();
  if (cmd) keys.push(`bash:${scope}:command:${cmd}`);  // 精确命令
  keys.push(`bash:${scope}:all`);                       // 本 thread 全部 bash
}
if (source === "acp") {  // MCP / 外部工具
  const k = (metadata?.kind || metadata?.toolName || "").trim();
  if (k) keys.push(`acp:${scope}:tool:${k}`);
  keys.push(`acp:${scope}:all`);
}
// 命中任一 key 且其值为 allow_always → 直放
```

**设计要点**：
- **thread 作用域**：`thread:<id>` 把「始终允许」锁在当前对话。换个 thread 仍要批——这是它比 Eva 全局白名单细的地方。`thread:global` 是显式全局兜底（ Alma 保留，Eva 可选）。
- **命令粒度**：bash 到「完整命令字符串」，不是「整个 bash 工具」。`allow_always` 可以只放 `npm test` 这一条。
- **两级回退**：精确 key（`command:npm test`）→ 粗 key（`:all`）。命中哪个用哪个。

### 2.2 七级自动放行链（`main:27910-28140` 顺序还原）

`Sy()` 按序短路，命中即返回 `{approved, action, reason}`，不再弹审批：

```
1. headless 环境变量      ALMA_HEADLESS=1 → 按 ALMA_TOOL_APPROVAL(auto/deny) 直判
2. allow_always 记忆命中   policy key 查中且值为 allow_always → 直放
3. 全局 autoApprove        settings.security.autoApproveToolRequests → 直放
4. isSubagent             子代理 → 直放(自动批准,落台账)
5. 渠道/群组               无人值守通道(telegram/discord…)→ 直放
6. cron 线程              thread.metadata.isCron 或 title 以「⏰ Cron:」开头 → 直放
7. thread-channel 映射     渠道映射的 thread → 直放
全部未命中 → 弹审批对话框(120s 超时硬上限 → deny)
```

**Eva 只抄 2/3/4**（allow_always 记忆、全局 autoApprove、isSubagent）。1（headless）Eva 无头模式暂不需要；5/6/7（渠道/cron）是 Alma 多通道 flavor，Eva 不做（14 §15 第 4 条）。**第 7 级之后的「120s 超时」明确不抄**。

### 2.3 bash 本地规则快速分级（`main:33129-33160` `Hb` 指令前半段）

Alma 在弹审批前先跑**本地规则**（无模型调用）：

- **直放安全命令**（只读枚举）：`ls / cat / grep / find / pwd / echo / head / tail / wc / git status / git log / git diff / which / env …`
- **必批命令**（写/删/执行/网络枚举）：`rm / mv / cp -r / chmod / chown / sudo / git push / git reset / curl|sh / wget|sh / npm install …`
- **灰色地带**（不在两个枚举里）：升级到风险分析（Alma 用小模型二审，**Eva 推迟**，灰色一律弹审批）。

后半段「小模型二次判定」Eva 不抄——成本是一次额外模型调用，收益对 coding agent 不明确，推迟到有真实误报压力再说。

## 3. Eva 改造点

### 3.1 policy key 生成 + 持久化（核心）

新增 `eva:packages/harness/src/approval/policy-key.ts`（纯函数，无 IO；内部对 bash 先跑 `classifyToolRisk`，命中 destructive 直接返回空数组做双保险）：

```ts
export interface PolicyKeyInput {
  toolName: string;            // "bash" | "write" | "edit" | "mcp__xxx__yyy" | ...
  threadId: string;            // 当前会话
  args: Record<string, unknown>;
}

/** 生成候选 policy key,精确在前、粗放在后。返回空数组 = 该工具不支持记忆。 */
export const buildPolicyKeys = (i: PolicyKeyInput): string[] => {
  const scope = `thread:${i.threadId}`;
  if (i.toolName === "bash") {
    const cmd = typeof i.args.command === "string" ? i.args.command.trim() : "";
    const keys = cmd ? [`bash:${scope}:command:${cmd}`] : [];
    keys.push(`bash:${scope}:all`);
    return keys;
  }
  if (i.toolName === "write" || i.toolName === "edit") {
    return [`${i.toolName}:${scope}:all`];   // 文件工具只到「本 thread 全部 write/edit」
  }
  if (i.toolName.startsWith("mcp__")) {
    return [`mcp:${scope}:tool:${i.toolName}`, `mcp:${scope}:all`];
  }
  return [];
};
```

**持久化**：`settings.security` 增一个字段，不动表结构（settings 是 JSON 列）：

```ts
// 旧:alwaysAllowTools: string[]          (全局 per-tool)
// 增:allowAlwaysPolicies: string[]       (thread 作用域 policy key 列表)
```

保留旧字段做迁移：启动时把 `alwaysAllowTools` 里的 `bash` 之类折成 `bash:thread:global:all`（显式全局），逐条并入 `allowAlwaysPolicies`，清空旧字段。一次性迁移函数放 `migrate-legacy.ts`（Eva 已有这个文件的模式）。

**destructive 永不进 policy**：risk=destructive 的调用（rm -rf / sudo / git push --force），前端不给「始终允许」按钮（已有），后端 `buildPolicyKeys` 命中 destructive 形态时**返回空数组**双保险——即使有人手改 settings，后端也不会记忆。

### 3.2 放行链插进 `runs.ts` 的 `requestApproval`（不是 `ask()` 内部）

Eva 的真实接线（`eva:apps/server/src/routes/runs.ts:53-73`）是「**先查白名单 → 再 `emit approval_request` → 才 `approvals.ask()`**」：

```ts
const requestApproval: RequestApproval = async ({ toolCallId, toolName, args }) => {
  const settings = loadAppSettings(app.infra.db, app.infra.config);
  // 现状:全局 per-tool 白名单(T14)
  if (settings.security.alwaysAllowTools.includes(toolName)) return true;

  const risk = classifyToolRisk(toolName, args);
  emit({ type: "approval_request", callId: toolCallId, toolName, args, risk });  // ← 先发了卡片
  const approved = await app.services.approvals.ask(toolCallId, {...});           // ← 才进闸门
  emit({ type: "approval_resolved", callId: toolCallId, approved });
  return approved;
};
```

**短路点必须在 `emit approval_request` 之前**——放进 `ask()` 内部的话，policy 命中也已先发了一帧 `approval_request`，前端卡片闪一帧再消失。所以在 `requestApproval` 的「全局白名单判断」处换成 policy 查询：

```ts
// runs.ts requestApproval 内,替换现有 alwaysAllowTools 判断
const policies = app.services.approvalPolicies;   // 新增 service(T28)
const hit = policies.match({ toolName, threadId: sessionId, args });
if (hit === "allow_always") {
  app.services.approvals.recordGranted(toolCallId, { runId, sessionId, tool: toolName, args },
                                       `policy:${hitKey}`);   // 台账照记
  return true;   // 直放,不 emit approval_request
}
```

- `policyStore`（`app.services.approvalPolicies`）是 `settings.security.allowAlwaysPolicies` 的进程内缓存 + 写回器，**不嵌进 `ApprovalGateway`**——gateway 只管「问与答」，不管「策略」。
- 台账照记：`approval_requests` 需加 `reason` 列（现状无此列，`eva:apps/server/src/db/schema.ts:263`），policy 命中落 `granted` + `reason=policy:<key>`，与 Alma `autoApprove` 落库一致。

### 3.3 bash 安全直放

在 `with-approval.ts` 的 `requestApproval` 之前加一道（只对 bash）：

```ts
// harness 侧,包 execute 前判断
if (agentTool.name === "bash" && isSafeReadOnlyCommand(args.command)) {
  return innerExecute(input, options);   // 直放,不进审批
}
```

`isSafeReadOnlyCommand` 放 `risk.ts` 旁边（`risk.ts` 已管 bash 形态，同源）。只认**纯白名单只读命令**（`ls/cat/grep/find/pwd/echo/head/tail/wc/git status/git log/git diff/which`），且**排除任何重定向/管道到写操作**（`>`、`>>`、`| sh`、`| tee`）。判定保守：拿不准一律不直放（进审批）。

> **与 risk.ts 的关系**：risk.ts 是给用户看的风险画像（normal/elevated/destructive），`isSafeReadOnlyCommand` 是决定要不要弹窗的放行开关。两者独立：一个命令可以 risk=elevated 但仍需审批（现状），也可以 risk=normal 且直放（S18 新增）。直放只发生在「normal 且在只读白名单」。

### 3.4 决策回写消息 part

Alma 把 `approvalDecision={action, reason, decidedAt}` 挂进工具结果回调（`main:28718-28735`，`{action, reason: e.denyReason, decidedAt: Date.now()}`）。Eva 落地：

1. `packages/shared/src/stream-events.ts` 的 `RunApprovalResolvedEvent` 已有 `callId`；**扩展 payload** 带 `decision: {action: "granted"|"denied", decidedAt: string}`。
2. **落库写入点在 `finish()` 不在 `decide()`**——`decide()` 时 assistant 消息还在在飞的 `UiMessageBuilder`（`runs.ts` 收尾才落库），gateway 服务单例拿不到路由闭包里的 recorder。所以落库走「`finish()` 时从 `approval_requests.getById` 查回写进 part 的 `metadata.approvalDecision`」，这一并覆盖 `cancelByRun`/`autoApprove`。实时态经 `approval_resolved` 帧推前端。
3. 前端 `approval-card` 决策后定格成「已允许/已拒绝 + 时间」，刷新后从消息 part 恢复（不再只依赖 `listApprovals` 的 pending）。

这一步让「当时批没批、批的什么」成为消息历史的一部分——和 Alma「审批决策随消息走」对齐，也让刷新后能看到已决策态（现在刷新只恢复 pending，已决策的凭空消失）。

## 4. 验收标准（对齐 11 §3.5 S18）

- [ ] 同 thread 内对某 bash 命令点「始终允许」后，**再次触发同一条命令不再弹审批**；**换一个 thread 仍弹**
- [ ] `ls -la` / `git status` 类只读命令**直放不弹**；`rm -rf` / `curl x | sh` / `npm install` **必弹**
- [ ] 审批决策（action + decidedAt）出现在消息 part 上，**刷新页面后已决策卡片仍在**（不只剩 pending）
- [ ] destructive 命令（rm -rf）即使用户想「始终允许」也没有这个选项，且后端 policy key 生成为空双保险
- [ ] policy 命中的放行在 `approval_requests` 台账里有 `granted` 记录

## 5. 施工拆分（r7 T 任务）

S18 是一个切片，施工时拆成 `docs/plans/r7/` 下的 T 任务（一次 commit 级）：

| T 任务 | 内容 | 依赖 |
|---|---|---|
| T27 policy-key + 持久化 | `policy-key.ts` 纯函数 + settings 增 `allowAlwaysPolicies` + 旧白名单迁移 + destructive 置空 | — |
| T28 放行链接入闸门 | `runs.ts` 的 `requestApproval` 在 `emit approval_request` **前**插 policy 查询 + 新增 `approvalPolicies` service（policyStore）+ `approval_requests` 加 `reason` 列 + 台账标 `policy:<key>` | T27 |
| T29 bash 安全直放 | `isSafeReadOnlyCommand` + with-approval 短路 + 重定向/管道排除 | — |
| T30 决策回写 part | SSE `approval_resolved` 扩 payload + `finish()` 时从 `approval_requests` 查回写进 part `metadata.approvalDecision` + 前端卡片定格已决策态 | T28 |

每个 T 带「做什么 / 改哪个文件 / 验收 / 测试」，进 r7 时再展开。S18 全绿 = T27–T30 全绿 + §4 验收过。

## 6. 明确不做（防漂移）

- **不抄 120s 超时**：Alma 为无人值守渠道妥协，Eva 14 §4.4 已定「永远等人」。渠道/cron 那三级放行链（5/6/7）也不抄。
- **不抄小模型二审**：灰色命令一律弹审批，不为一处误报付一次模型调用。
- **不做 headless 模式**：Eva server 是桌面内嵌 UtilityProcess，没有无人值守场景。
- **不动闸门主干**：`withApproval` 包装法、`cancelByRun`、`failStalePending` 启动清扫全部保留，S18 只在前面加放行、在后面加回写。
