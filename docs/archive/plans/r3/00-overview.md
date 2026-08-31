# R3 · 总览与执行契约

> 承接 `../r2/00-overview.md`。R1（T0–T4）、R2（T5–T10）已全部落地并 commit。
> 基线实证（`bebdd12`）：`pnpm typecheck` 全绿；`pnpm test` 31 文件 / 211 项全绿。
>
> **本轮主题：从「功能很多」变成「能装能用」。** 不做平台化（S6/S7/S9 留到 R4）。

---

## 0. R2 收口确认（代码实证）

| 项 | 实证 |
|---|---|
| 审批归属 run 化 | `RunRegistry` 只存 runId→AbortController；`tests/approval-abort.test.ts` |
| 工作区 | `workspaces` 表 + 会话绑定 + per-run 注入 + `CLAUDE.md` 注入；`TARGET_REPO_ROOT` 已删 |
| provider/槽位 | `provider-catalog.ts` 单一事实源；`settings.models.{chat,tool,embedding}`；`agent.ts` 139 行 |
| 会话可观测 | `deriveSessionStatus` + `/threads/:id/{status,usage}` + LLM 摘要 compact |
| MCP | `mcp_servers` 表 + stdio/http + `mcp__server__tool` + 审批默认开 |
| 遗留清理 | 0019 删 6 个死列/死表；`/settings/*` 已是真路由（`settings-layout.tsx` + `Outlet`） |

---

## 1. 本轮要解决的问题（全部有代码实证）

### 1.1 🔴 装不上：`pnpm desktop:pack` 现在跑不通，跑通了也是空白窗口

| # | 缺口 | 实证 |
|---|---|---|
| P1 | `electron-builder.yml:14` 引用 `.server-deploy/node_modules/`，**该目录不存在且全仓库无任何脚本产出它**（唯一其它出现是 `files` 里的 `"!.server-deploy"` 排除） | `ls apps/desktop/.server-deploy` → 不存在；`grep -rn server-deploy` 只命中那两行 |
| P2 | `tsup.config.ts` 把所有依赖设为 external，`dist/index.js` 运行时需要 `@ai-sdk/* ai better-sqlite3 drizzle-orm fastify pino sqlite-vec zod dotenv @modelcontextprotocol/sdk @fastify/static`——全靠 P1 那个目录提供 | 从 `dist/index.js` 抽 import 得到的清单 |
| P3 | **前端产物从来没进过包**。`routes/static.ts:15` 打包态在 `Resources/web/dist` 找 SPA，但 `extraResources` 里没有 `apps/web/dist` | 对比 `electron-builder.yml` 与 `static.ts` |
| P4 | `desktop:build` = `build:server + build:electron`，**根本不构建 web** | `apps/desktop/package.json` scripts |
| P5 | **原生模块 ABI 不匹配**。server 跑在 `utilityProcess.fork` 里（Electron 的 Node），而 `better_sqlite3.node` 是按系统 Node ABI（127 / node 22.22）编译的；仓库里**没有任何 rebuild 步骤** | `node -p process.versions.modules` → 127；`grep electron-rebuild` → 无 |
| P6 | **skills 无处可放**。dev 态读 `<monorepo>/skills`（不存在），打包态读 `Resources/server/skills`（App 包内部，用户改不了）。`docs 14 §7.3` 规定的位置是 `~/.eva/skills/` | `ls skills/` → 不存在；`deps.ts` 的 `findMonorepoRoot(process.cwd())` |

> **为什么一直没暴露**：`main.ts` 在 `isDev` 分支**不 fork server**（server 由 `tsx` 在系统 Node 上单独跑，UI 走 Vite 5173）。也就是说 UtilityProcess + 原生模块这条路**从来没被执行过**。

### 1.2 🟡 用不顺：模型答歪了只能作废整个会话

`messages` 表的版本树三件套（`parent_id` / `slot_id` / `depth`）在 R1 T1 就建好了，但语义没启用：

```ts
// apps/server/src/services/session.ts:125
slotId: randomUUID(),                              // 每条消息各自一个 slot → 按构造不可能有版本
...(previous ? { parentId: previous.id } : {})      // parent 永远是时间上的上一条 → 树退化成链
```

`grep -rn "switch-version\|regenerate"` 全仓库零命中。没有「重新生成」，也没有版本切换。

### 1.3 🟢 工程缺口

| # | 缺口 | 实证 |
|---|---|---|
| C1 | `apps/web` 没有 `typecheck` 脚本 → 根 `pnpm typecheck`（`-r --if-present`）**整个跳过前端** | `grep typecheck apps/web/package.json` → 无（手工跑当前是干净的） |
| C2 | 全仓库无 `setErrorHandler` → 任何请求体不合法都是 **500** 而不是 400 | `grep -rn setErrorHandler apps/server/src` → 无 |
| C3 | `docs/architecture/15` §1 进度表有 4 行是 R1 前的旧状态，**声称已修好的东西是坏的** | 见 `T13-chores.md` §3 逐条对照 |
| C4 | 「始终允许」是全局 `settings.security.autoApproveToolRequests` 一个开关，放开**所有**危险工具；无 per-tool 白名单，bash 危险命令未标注 | `routes/runs.ts:182` |

---

## 2. R3 范围与顺序

| 任务 | 文档 | 内容 | 估时 | 依赖 |
|---|---|---|---|---|
| **T11** | [`T11-packaging.md`](./T11-packaging.md) | 打包链路修通（P1–P6）+ 单实例锁。验收 = dmg 能装、装完能聊天 | 2–3 天 | — |
| **T12** | [`T12-regenerate.md`](./T12-regenerate.md) | 「重新生成」+ 版本切换（1.2）。**不做编辑分叉** | 3–4 天 | — |
| **T13** | [`T13-chores.md`](./T13-chores.md) | C1/C2/C3 工程小修 | 0.5–1 天 | — |
| **T14** | [`T14-per-tool-approval.md`](./T14-per-tool-approval.md) | per-tool 审批白名单 + bash 危险命令标注（C4） | 2–3 天 | T12 无关，可延后 |

四个任务**互不依赖**，可任意顺序 / 并行。建议顺序 `T11 → T12 → T13 → T14`：

1. **T11 最优先**：其它一切做得再好，装不上就用不上。而且它是唯一一条**从未被执行过**的代码路径（§1.1 末尾），风险最高、越晚发现越贵。
2. **T12 次之**：「答歪了要能重来」是聊天产品的基本功能，而数据地基已经付过成本。
3. T13 是半天的收尾，随时插。
4. T14 是真功能但不阻塞任何人。

### 2.1 为什么本轮不做 S6/S7/S9

偏离 `docs/architecture/15` 写的关键路径 `S6 → S9 → S7 → S11`，理由：

- **S6 扩展宿主是 1–2 周的平台工程，收益要等 S9 才显现。在还没人日常用这个 app 的时候设计槽位，长出来的形状八成是错的。** 这正是 `r2/T9-mcp.md` §0 里拒绝「为 S6 预留 MCP 接口」时写下的理由 —— 对 S6 本身同样成立：先让 Eva 变成每天用的工具，从真实使用里长出槽位需求。
- **S7 子代理**要真有用需要子代理消息树的前端视图；T12 做完之后那套「同一位置多个版本」的渲染与切换正好能复用。顺序上它应该在 T12 之后。
- S11 的其余部分（自动更新 / 托盘 / `eva://` 深链 / 全局唤起）在 T11 把包打通之后按需补 —— 它们都是"锦上添花"，而 T11 是"有没有花"。

R4 = S6 → S9，R5 = S7 + S11 其余。

---

## 3. 执行契约

**完全沿用 `../r1/00-overview.md` §1**（硬性流程、硬性边界、TypeScript 约束、代码风格、已知坑）与 `../r2/00-overview.md` §3 追加的四条（不用补丁修架构、命名要形象、删东西给 grep 实证、FINDINGS 只写 `../r1/FINDINGS.md`）。开工前必读。

R3 追加两条：

1. **T11 的验收只有一种形式：装出来的 app 真的能聊天。** 这个任务里所有"看起来应该对"的推断都不算完成 —— 因为它修的正是"从来没跑过的那条路"。每一步都要在**打包产物**里验，不是在 dev 里验。

2. **T12 的读路径必须先改，再改前端。** 一旦同一个 slot 里有两条消息，而 `buildModelHistory` 仍返回全部，模型就会同时看到 v1 和 v2 —— 它不会报错，只会让模型开始说奇怪的话。顺序颠倒会埋一个静默的上下文污染 bug。

---

## 4. 验收总表

| 任务 | 一句话验收 |
|---|---|
| T11 | `pnpm desktop:pack` 产出 dmg；装到 /Applications 打开能发消息、能读写工作区文件、记忆检索可用；`~/.eva/skills/` 放一个 SKILL.md 能被加载 |
| T12 | 对最后一条回复点「重新生成」得到 v2，气泡下出现 `‹ 2/2 ›` 可来回切；切到 v1 后继续对话，v2 那条分支仍可切回；**模型上下文里只有激活分支** |
| T13 | 根 `pnpm typecheck` 覆盖前端；坏请求体返回 400 而不是 500；`docs/architecture/15` §1 每一行都与代码对得上 |
| T14 | 审批卡片上点「始终允许」只放开该工具，其它危险工具照旧弹；bash 命令命中危险模式时卡片上有标注 |
