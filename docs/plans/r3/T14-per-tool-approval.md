# T14 · per-tool 审批白名单 + bash 危险命令标注

> 前置：无（与 T11/T12/T13 互不依赖，可延后）。
> 开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §3。
> 施工图：`docs/architecture/14-eva-architecture.md` §4.4（审批闸门）。

---

## 1. 问题实证

### 1.1 「始终允许」是一个核按钮

```ts
// apps/server/src/routes/runs.ts:182
if (settings.security.autoApproveToolRequests) {
  return true;                       // 放开的是**所有**危险工具
}
```

```ts
// apps/web/src/features/threads/chat-page.tsx:29
security: { ...current.security, autoApproveToolRequests: true }
```

前端「始终允许」按钮写的是这个全局开关。也就是说：用户为了不再被 `write` 反复打断而点了它，
**顺带把 `bash` 和 `edit` 也永久放开了** —— 而且没有任何 UI 提示这件事发生了。

`docs 14 §4.4` 要求的是「"始终允许"写 per-tool 记忆」，不是全局开关。

### 1.2 危险命令没有任何提示

审批卡片对 bash 只展示命令原文（`approval-card.tsx:14` 的 `summarizeArgs`）。
`rm -rf /` 和 `ls` 在卡片上长得一样 —— 用户在连续点了十次「允许」之后，第十一次不会仔细看。

`docs/plans/r2/T5` 时代就把这条记为"S4 残余"，一直没做。

---

## 2. 目标设计

### 2.1 白名单取代全局开关

```ts
// AppSettings.security
{
  /** 免审批的工具名。空数组 = 每个危险工具都要问。 */
  readonly alwaysAllowTools: readonly string[];
  readonly logLevel: ...;
}
```

**删掉 `autoApproveToolRequests`。** 不保留"全局放开"这个选项：

- 它的真实用途是"我信任这个工具"，而那正是白名单表达的；
- 保留一个能一键放开 bash 的开关，等于把 R1 T0.4 建的闸门留了个后门，而且用户点它的时候
  不知道自己放开了什么。

迁移：旧值为 `true` 的库 → 白名单填入当前所有危险工具名（`bash` / `write` / `edit`），
并 `logger.warn` 说明"全局自动审批已拆成 per-tool 白名单，已按原有信任范围迁移"。
旧值为 `false` → 空数组。

> MCP 工具的 `autoApproveTools` 是 **per-server** 的（`mcp_servers.auto_approve_tools`，R2 T9 建的），
> 与这里的全局白名单是两套。判定顺序：MCP 侧先判（server 配置更具体），再判全局白名单。
> 两者都不命中才弹卡片。

### 2.2 风险标注：一个纯函数，注入到审批事件里

```ts
// packages/harness/src/tools/risk.ts
export type ToolRiskLevel = "normal" | "elevated" | "destructive";

export interface ToolRisk {
  readonly level: ToolRiskLevel;
  /** 命中的原因，直接展示给用户（如 "递归删除"、"写入工作区外"）。 */
  readonly reasons: readonly string[];
}

/**
 * 危险工具调用的风险画像。纯函数、无 IO —— 它只看工具名与入参。
 *
 * 为什么放 harness：工具是 harness 定义的，"哪些参数形态是危险的"属于工具知识。
 * 服务端在发 approval_request 事件时调它，把结果附在事件上。
 */
export const classifyToolRisk = (
  toolName: string,
  args: Record<string, unknown>
): ToolRisk;
```

bash 的判定模式（每条都要注释"为什么危险"，并配测试钉死）：

| 模式 | level | reason |
|---|---|---|
| `rm -rf` / `rm -fr` / `rm --recursive --force` | destructive | 递归强制删除 |
| 重定向覆盖到路径（`> /`、`>` 后跟绝对路径） | elevated | 覆盖写入 |
| `sudo` / `chmod 777` / `chown` | destructive | 提权或改权限 |
| `git push --force` / `git reset --hard` | destructive | 不可逆的 git 操作 |
| `curl`/`wget` 管道进 shell（`\| sh`、`\| bash`） | destructive | 下载即执行 |
| `:(){` fork bomb 形态 | destructive | fork bomb |
| 其余 bash | elevated | （bash 本身就是 elevated） |
| `write` / `edit` 落在工作区内 | elevated | 修改文件 |

> **不做命令解析**。用正则匹配形态，宁可误报（多标一个 destructive）也不漏报。
> 这里的产出只用于**给用户看**，不用于自动拒绝 —— 所以误报的代价只是多看一眼。

`RunApprovalRequestEvent` 加 `risk: ToolRisk`。

### 2.3 前端

- 审批卡片按 `risk.level` 换色/图标：`destructive` = 红底 + `ShieldAlert`，`elevated` = 现有的 warning 黄。
- `risk.reasons` 以小标签形式列在命令下方。
- 「始终允许」的文案改成 **「始终允许 `bash`」**（带上工具名），点了之后把该工具名写进
  `settings.security.alwaysAllowTools`。
- `destructive` 时**不显示**「始终允许」按钮 —— 一个会 `rm -rf` 的工具不该有"以后别问了"这个选项。

---

## 3. 涉及文件

### 新增
| 文件 | 内容 |
|---|---|
| `packages/harness/src/tools/risk.ts` | `classifyToolRisk` |
| `apps/server/src/db/migrations/0021_always_allow_tools.sql` | settings 迁移（若用 SQL 做）或走 `migrate-legacy` 式的启动迁移 |
| `tests/tool-risk.test.ts` | 每条模式一个用例 |

### 修改
| 文件 | 动作 |
|---|---|
| `packages/harness/src/index.ts` | 导出 risk |
| `packages/shared/src/index.ts` | `AppSettings.security`：删 `autoApproveToolRequests`，加 `alwaysAllowTools` |
| `packages/shared/src/stream-events.ts` | `RunApprovalRequestEvent.risk` |
| `apps/server/src/services/settings/app-settings.ts` | 默认值 |
| `apps/server/src/services/settings/migrate-legacy.ts` | 旧开关 → 白名单的一次性迁移 |
| `apps/server/src/routes/settings.ts` | zod schema |
| `apps/server/src/routes/runs.ts` | `requestApproval` 判白名单；发事件时附 `risk` |
| `apps/web/src/features/threads/components/approval-card.tsx` | 风险配色 + reasons + 带工具名的按钮 + destructive 不给"始终允许" |
| `apps/web/src/features/threads/chat-page.tsx` | 「始终允许」写白名单而不是全局开关 |
| `apps/web/src/features/threads/api.ts` / `hooks/use-approvals.ts` | 传工具名 |
| `apps/web/src/features/settings/components/*` | Settings 里能查看/移除白名单条目 |

---

## 4. 步骤

1. **【测试先行】`tests/tool-risk.test.ts` + `risk.ts`** —— 纯函数，先把 §2.2 那张表逐行变成用例。
   包含"`ls` 是 elevated 不是 destructive"这类反例，防止正则写太宽。
2. **契约改动**：`AppSettings.security` 与 `RunApprovalRequestEvent`。先改 `packages/shared`，
   跑 typecheck 列出所有断点（前端断点需要 T13 的 C1 已完成，否则要手工跑 web 的 tsc）。
3. **一次性迁移**：`migrate-legacy.ts` 里加一段，`autoApproveToolRequests === true` →
   `alwaysAllowTools = ["bash", "write", "edit"]`，并 warn 留痕。**幂等**（以"存在
   `alwaysAllowTools` 字段"为已迁移标志）。
4. **服务端接线**：`routes/runs.ts` 的 `requestApproval`
   ```
   MCP 侧 per-server 白名单（已有,在 mcp-tools.ts 判）
     → settings.security.alwaysAllowTools 命中 → 直接放行
     → 否则 emit approval_request（附 risk）并等决策
   ```
5. **前端**：卡片配色 / reasons / 按钮文案 / destructive 隐藏"始终允许" / Settings 里管理白名单。
6. **手工验收**（见 §5）。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；`tool-risk` 测试 RED→GREEN
- [ ] `grep -rn "autoApproveToolRequests" apps packages` 只在 `migrate-legacy.ts` 里出现
- [ ] 手工：让 agent 写文件 → 卡片黄色、按钮写「始终允许 `write`」→ 点它 → 再写文件不再弹
- [ ] 手工：接着让 agent 跑 `bash` → **仍然弹卡片**（证明白名单是 per-tool，不是全局）
- [ ] 手工：让 agent 跑 `rm -rf /tmp/xxx` → 卡片红色、reasons 里有"递归强制删除"、**没有**「始终允许」按钮
- [ ] 手工：`ls -la` → 卡片是黄色 elevated，不是红色（反例，防误报过宽）
- [ ] 手工：Settings 里能看到白名单里有 `write`，能移除；移除后再写文件又开始弹
- [ ] 升级验证：把旧库的 `autoApproveToolRequests` 置 true → 启动 → 白名单被填成三个工具 + 日志留痕

## 6. 坑

1. **风险判定只用于展示，不要用它自动拒绝**。误报（把 `ls` 判成 destructive）的代价必须只是"多看一眼"，
   一旦它能阻断执行，误报就变成了功能故障。
2. **正则要防绕过但别追求完备**。`rm -r -f`、`rm --recursive`、变量拼接 `$CMD -rf` 都能绕 ——
   本任务的目标是"常见危险形态有提示"，不是沙箱。真正的边界是 `resolveWorkspacePath` 的路径沙盒
   与审批本身。别在注释里把它写成安全保证。
3. **删 `autoApproveToolRequests` 是破坏性契约改动**，`AppSettings` 前后端共享。迁移必须幂等，
   且要在 commit 正文里写明"旧的 true 会被翻译成三个工具的白名单"。
4. **MCP 与本地工具是两套白名单**，别合并。per-server 的更具体（同一个工具名可能来自不同 server），
   合并会让"信任 km 的 search"变成"信任所有叫 search 的工具"。
