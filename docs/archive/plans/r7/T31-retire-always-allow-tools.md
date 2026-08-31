# T31 · 退役 `alwaysAllowTools`:「始终允许」改走 policy 单一事实来源

> 依赖 **T27/T28**(`buildPolicyKeys` + `ApprovalPolicyStore.grant`)。触发点:实测发现「始终允许 bash」走 T14 全局白名单,把整个 bash 工具全域放行(所有 thread、所有命令),与 r7 §3 契约 1「policy key 是单一事实来源」直接冲突 —— `alwaysAllowTools` 是残留的第二个事实源。
> 前置阅读:`00-overview.md` §3.1;`docs/architecture/22 §2.2、§3.1`。

## 1. 问题

`allowAlwaysPolicies`(thread 作用域 policy)在语义上**完全覆盖** `alwaysAllowTools`(全局 per-tool):后者 `["bash"]` 等价于前者的 `bash:thread:global:all`(T27 迁移正是这么折的,且迁完把旧字段清空)。但仍有三处连着旧字段:

- `runs.ts` 放行链第一道 `.includes(toolName)`(对迁后的空数组永 false,死代码;对未迁老库是兜底)。
- `chat-page.tsx` 「始终允许」按钮仍写 `alwaysAllowTools`(整个工具全域放行 —— 就是实测踩到的坑)。
- `security-settings.tsx` 设置页渲染/删除的是 `alwaysAllowTools`。

留着它,「为什么这条没弹窗」就有两个答案来源。

## 2. 改动

### 2.1 「始终允许」按钮 → grant 路由(选 key 必须在后端)

前端 `pending` 里没有 `sessionId`,`buildPolicyKeys` 又是 harness 纯函数 —— **key 生成必须在后端**(单一事实来源)。新增 REST:

```
POST /api/v1/approval-policies/grant   { tool, sessionId, args } → { key } | { key: null }
```

`routes/approval-policies.ts`(新建):`buildPolicyKeys({toolName, threadId: sessionId, args})` 取 `keys[0]`(精确 key,T27 顺序保证),`approvalPolicies.grant(key)`;`keys.length===0`(destructive/未知)→ `{ key: null }` 不落库。注册进 `routes/index.ts`。

前端 `api.ts` 增 `grantApprovalPolicy(tool, sessionId, args)`;`chat-page` 的 `enableAutoApprove` 换成它 —— 从 `useChat` 拿当前 `sessionId`、`target.args` 一起传。`useApprovals.allowAlways` 签名从 `(toolName)` 改 `(tool, args)`。

### 2.2 设置页 → policies

`security-settings.tsx` 改读 `data.security.allowAlwaysPolicies`,移除 = `saveSettings` 整块写回 `filter` 后的列表(与 chat-page 同款 spread,不是 grant 逆操作 —— 直接改 settings 这一块即可,`replaceAppSettings` 整块重写天然覆盖)。

### 2.3 删字段

`shared/index.ts` `security.alwaysAllowPolicies` 保留、删 `alwaysAllowTools`;`app-settings.ts` 默认值、`settings.ts` zod 同步删;`runs.ts:67` 那道 `.includes` 删掉(放行链第一道直接进 T28 policy 短路)。

### 2.4 迁移收敛

`migrateAlwaysAllowToolsToPolicies` 迁完不再写 `alwaysAllowTools: []`,而是整块 security 只留 `{ logLevel, allowAlwaysPolicies }` —— 「迁完即净」,settings 里不再有第二个事实源的键。幂等标志(存在 `allowAlwaysPolicies`)不变。

## 3. 涉及文件

修改:`packages/shared/src/index.ts`、`apps/server/src/services/settings/app-settings.ts`、`apps/server/src/routes/settings.ts`、`apps/server/src/routes/runs.ts`、`apps/server/src/services/settings/migrate-legacy.ts`、`apps/server/src/routes/index.ts`、`apps/web/src/features/threads/api.ts`、`apps/web/src/features/threads/chat-page.tsx`、`apps/web/src/features/threads/hooks/use-approvals.ts`、`apps/web/src/features/settings/components/security-settings.tsx`。

新增:`apps/server/src/routes/approval-policies.ts`、`tests/always-allow-retire.test.ts`。

## 4. 步骤

1. RED:退役测试(§上文 6 条钉线 + grant 选 key 4 条)。已红 6 条。
2. GREEN:先 shared/server 删字段 + 迁移收敛,再 grant 路由,再前端三处。
3. `pnpm typecheck && pnpm test` 全绿。

## 5. 验收

| # | 验收 | 判定 |
|---|---|---|
| 1 | 点「始终允许」→ 同 thread 同命令直放,**换 thread / 换命令仍弹** | 台账 `policy:bash:thread:<id>:command:<cmd>`;E2E |
| 2 | settings 里不再有 `alwaysAllowTools` 键 | `SELECT value FROM settings WHERE key='security'` |
| 3 | 老库迁成 `thread:global:all` 后字段不残留 | 迁移测试 |
| 4 | 全仓 `alwaysAllowTools` 零引用 | `grep` |
| 5 | 移除实验:摘 runs.ts policy 短路 → grant 后仍弹(回到 T27 前) | 钉线用例转红 |

## 6. 坑

1. **key 生成别挪到前端**。`buildPolicyKeys` 在 harness,前端 import 它 = 第二个拼装点;走 REST 让后端选 key,前端只传 `{tool, sessionId, args}`。
2. **`keys[0]` 是精确 key 不是 `:all`**。T27 保证精确在前;点「始终允许 `npm test`」只记这一条命令,不是 `bash:thread:x:all`(那等于把 thread 内所有 bash 都放了)。
3. **grant 路由要处理 `keys[0]` 不存在**(destructive/未知工具)→ 返回 `{key:null}`,前端不弹「已加入」。
4. **设置页删除走 settings 整块写回**,不是新增 revoke 路由 —— `replaceAppSettings` 本来就整块重写,filter 后写回即可,别多造一个端点。
