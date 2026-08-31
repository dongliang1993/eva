# R2 · 总览与执行契约

> 承接 `../r1/00-overview.md`。R1（T0–T4）已全部落地并 commit（`0350f30`..`689ac33`）。
> 本轮把地基**收口**（审批归属、工作区、provider 层、会话运行时），并加一块高性价比的能力扩张（MCP）。
> 基线实证（`689ac33`）：`pnpm typecheck` 全绿；`pnpm test` 21 文件 / 142 项全绿。

---

## 0. R1 收口确认（代码实证，非自述）

| 项 | 实证 |
|---|---|
| 模型 per-run 解析 | `services/agent-factory.ts` + `AppServices.agents`；`RunApiService` / `buildChatAgent` 已不存在 |
| 向量不再丢 | `db/index.ts:createVecTables` 按维度判定重建；`tests/db-vec-persistence.test.ts` 钉住 |
| fs 根目录显式 | `deps.ts:resolveWorkRoot` 拒绝空值 / 不存在 / `$HOME` / `/` |
| 工具能跑通 | `tools/with-approval.ts` 包 execute；`tests/approval-flow.test.ts` 6 项 |
| UIMessage 整存 | `messages.message` 列存 `{id, role, parts[]}`；`runs` 台账表 + `failStale()` |
| harness 收敛 | `lead-agent.ts` 395 行（原 893），`streamText({stopWhen, prepareStep})`，无手写 step 循环 |
| 前端分层 | `features/{threads,settings}` + `shared/{api,ui,hooks,markdown,streaming}`；committed/streaming 双状态 + 虚拟化 |

---

## 1. 剩余 backlog 全景

按 `docs/architecture/15-eva-execution-playbook.md` 的 S 编号对齐，加上 R1 留下的结构债。
**每一条都给了代码实证**——没有实证的条目不许进这张表。

### 1.1 已经坏掉的功能（P0，不是待做项）

| # | 缺陷 | 实证 | 后果 |
|---|---|---|---|
| **P0.1** | **abort 不取消 pending 审批，run 吊死 5 分钟** | `routes/runs.ts` 调 `runRegistry.register(runId)` **没传第二个参数**，`RunRegistry.register(runId, sessionId = "")` 于是把 sessionId 存成空串。`abort()` 返回 `""`：SSE 断连分支 `if (abortedSessionId)` 空串为假 → 根本不调 `cancelBySession`；`/abort` 路由分支判的是 `=== undefined` → 调了 `cancelBySession("")`，匹配不到任何一条 pending。而 agent loop 正阻塞在审批 promise 上，`for await` 不退出 → `finally` 里那句能生效的 `cancelBySession(sessionId)` 永远不执行 | 审批卡片挂起时点停止 = 界面卡住，直到 `PENDING_TIMEOUT_MS`（5 分钟）兜底 |
| **P0.2** | 审批列表跨会话串台 | `routes/approvals.ts` 的 `GET /api/v1/tool-approvals` 调 `listPending()` **不传 sessionId**，返回全进程所有会话的 pending | A 会话刷新页面，弹出的是 B 会话的审批卡片 |

> `tests/approval-flow.test.ts` 全绿也挡不住这两条：它测的是 `ApprovalGateway` 单元与 agent 级审批语义，**没有一条测试跑过"路由装配 + abort"这条线**。

### 1.2 能力缺口

| # | 缺口 | 实证 | 严重度 |
|---|---|---|---|
| S3 | **工作区不存在** | 只有一个进程级 `TARGET_REPO_ROOT` env，在 `deps.ts` 装配期解析成 `infra.workRoot`。没有 `workspaces` 表、没有会话↔工作区绑定、没有导入入口、没有 `CLAUDE.md` 注入。**桌面端打包后用户没有任何途径开启文件能力**（env 只能改 `.env.local`） | 🔴 阻塞"能干活" |
| S4 残余 | 审批粒度粗 | "始终允许"写的是全局 `settings.security.autoApproveToolRequests`（一个开关放开所有危险工具），没有 per-tool 白名单；bash 危险命令未在审批卡片上标注 | 🟡 |
| S8 | **MCP 缺失** | 无 `mcp.json`、`@modelcontextprotocol/sdk` 未安装 | 🟡 能力天花板 |
| S7 | 子代理缺失 | R1 T4 摘掉了半成品，`Task`/`TaskOutput` 双原语未建 | 🟡 |
| S6 | 扩展宿主缺失 | 无 manifest/exposes/EH/slots | 🟢 |
| S9 | Git 面板缺失 | — | 🟢 |
| S11 | 桌面化未补完 | 无 updater / 托盘 / 深链 / 单实例锁 | 🟢 |
| — | run 台账不可见 | `runs` 表已建但**零路由暴露**；`session.status` 派生态（docs 14 §5.2）未落地；token 用量前端看不到（`settings.chat.showTokenUsage` 是个没人读的字段） | 🟡 |

### 1.3 结构债

| # | 债 | 实证 |
|---|---|---|
| D1 | **provider 知识三套且互不一致** | ① `agent.ts` 只认 `{openai, anthropic}`；② `provider-runtime.ts` 认 11 个 openai-compatible + google + azure + anthropic；③ `provider-models.ts` 又自带一张 4 条的 `DEFAULT_BASE_URLS`。`ProviderType` 有 14 个成员，其中 8 个（google/azure/aihubmix/copilot/acp/claude-subscription/zai-coding-plan/kimi-coding-plan）**从未被 agent runtime 支持过**——UI 上能选，选完 run 就 503 |
| D2 | **第二套 provider 配置** | `settings.memory.embedding = {baseUrl, apiKey, model}` 是裸字段，**明文 apiKey 存在 settings JSON blob 里**，完全绕开 `providers` 表（`memory-embedding.ts:resolveEmbeddingProvider`） |
| D3 | **槽位概念散落四处** | `settings.chat.defaultModel` / `settings.toolModel.model` / `settings.memory.toolModel` / `settings.memory.embedding.model` 都在表达"哪个模型干哪件事"。`memory-recall.ts:265` 的注释自己写着 fallback 链 `memory.toolModel → toolModel.model → chat.defaultModel` |
| D4 | `settings-store.ts` 689 行做 4 件事 | settings 读写 + provider CRUD + 内置模型目录 + model-id 解析。项目自己的约定是 200–400 行。附带一个隐患：`qualifyModelId` 用**字符串前缀猜 provider**（`startsWith("claude")` → anthropic，`startsWith("gpt")`/`startsWith("o")` → openai） |
| D5 | compact 摘要无 LLM | `services/compact.ts:generateSummaryText` 是确定性 bullet 拼接（文件里自己标了 `deterministic, no LLM`）。docs 14 §4.3 要求"摘要用 toolModel" |
| D6 | 死代码（比 R1 估计的多） | ① `services/provider-models.ts` 124 行 **零调用方**，连带 `provider_models_cache` / `model_capabilities_cache` 两张表零读写；② `sessions` 表 4 个死列（`reasoning_effort`/`tool_policy`/`skill_policy`/`memory_policy`）；③ `types/runs.ts:RunInput` 死接口；④ `routes/runs.ts` 末尾 `export type { EvaUIMessage }` 是给"未来接口"留的占位；⑤ `SessionService.resolveByKey` 只被测试调用；⑥ `models/{openai-compatible,anthropic}.ts` 的 `temperature` 字段注释写着"已不生效"仍在签名里；⑦ `Provider.apiVersion` 字段在 `providers` 表里**没有对应列**，永远是 undefined；⑧ `AppSettings` 有 12 个只被 zod 校验、无人读取的字段（`security.{encryptApiKeys,requirePassword,sessionTimeout}` / `chat.{streamResponse,autoSaveHistory,historyRetentionDays,defaultToolSelection,defaultSkillSelection,modelUsageHistory,enableMarkdown}` / `webSearch.engine`——搜索工具是硬编码 DuckDuckGo，这个字段是句谎话） |
| D7 | 命名撒谎 | `services/workspace/index.ts` 里是 `findWorkspaceRoot`（找 pnpm monorepo 根），跟即将到来的"工作区"领域概念**同名不同义** |
| D8 | `/settings/*` 不是真路由 | `settings-page.tsx` 用组件内 `activeNav` state 切 tab，直链打不开、前进后退无效（FINDINGS 已记 `[next]`） |
| D9 | 工具溢出文件写进用户仓库 | `agent.ts:229` 把 overflow 目录设成 `{workRoot}/.eva/tool-output` ——往用户的项目里拉屎。docs 14 §7.3 定的位置是 `~/.eva/tool-overflow/` |
| D10 | 桌面壳残留旧品牌 | `apps/desktop/electron/main.ts` 的加载页与日志写的是 `Work MI`，项目已改名 Eva |

---

## 2. R2 范围与顺序

| 任务 | 文档 | 内容 | 估时 | 依赖 |
|---|---|---|---|---|
| **T5** | [`T5-p0-fixes.md`](./T5-p0-fixes.md) | P0 修复：审批归属从 session 收敛到 run（修 P0.1/P0.2） | 0.5–1 天 | — |
| **T6** | [`T6-workspaces.md`](./T6-workspaces.md) | 工作区（S3）：`workspaces` 表 + 会话绑定 + fs 工具 per-run 注入 + 项目文档注入 + REST + 前端选择器。**删除 `TARGET_REPO_ROOT`**，顺手修 D7/D9 | 4–5 天 | T5 |
| **T7** | [`T7-provider-model-slots.md`](./T7-provider-model-slots.md) | provider 层重构 + 模型槽位统一：修 D1/D2/D3/D4 | 3–4 天 | T5 |
| **T8** | [`T8-session-runtime.md`](./T8-session-runtime.md) | 会话运行时可观测：`deriveSessionStatus` + run/用量接口 + 前端状态与用量展示 + LLM 摘要 compact（修 D5） | 2–3 天 | T7 |
| **T9** | [`T9-mcp.md`](./T9-mcp.md) | MCP 接入（S8）：`~/.eva/mcp.json` + 动态工具注册 + 审批默认开 + settings UI | 3–4 天 | T7 |
| **T10** | [`T10-cleanup.md`](./T10-cleanup.md) | 遗留清理 + settings 真路由 + 文档同步：修 D6/D8/D10 | 1.5–2 天 | T5–T9 |

```
T5(P0) ──┬──> T6(工作区) ───────────────┐
         │                              ├──> T10(清理+文档)
         └──> T7(provider) ──┬─> T8(运行时可观测) ─┤
                             └─> T9(MCP) ─────────┘
```

T6 与 T7 无相互依赖，可并行（不同人）或顺序做（同一人建议 T6 先，因为它解锁产品可用性）。

### 2.1 为什么是这个顺序

1. **T5 最优先且最便宜**：跟 R1 的 T0 同性质——"当前已经坏掉的功能"排在所有新功能前面。半天到一天，而且它顺手把 `RunRegistry` 化简成"runId → AbortController"，后面 T8 要用这个注册表判 `running` 态，早一点干净早一点省事。

2. **T6 紧随**：R1 T0.3 为了安全把 fs 工具默认关掉了，但没给用户开启的途径。桌面端用户现在装完 app 就是一个不能碰文件的聊天框——这是 R1 留下的唯一**产品级回退**，必须先补。而且它是 docs 15 关键路径 `S3 → S4 → S6 → S9` 的头一环。

3. **T7 与 T6 并列**：D1–D4 是当前最大的一块结构债，而且它**卡着三件后续事**——多模型槽位（docs 14 §4.1）、embedding 统一走 providers 表、compact 用 tool 槽位。晚改的成本会随 provider 数量线性上升。

4. **T8 依赖 T7**：LLM 摘要需要 tool 槽位。

5. **把 S8（MCP）提到 S6/S7 之前**——这里偏离了 docs 15 的原顺序，理由：
   - MCP 是**单位代码量能力增益最高**的一块：接一个 server 就多一组工具，不用写业务代码。对"work agent"（要连内部 KM / 工单 / GitLab）价值直接。
   - docs 15 把 S8 排在 S6 之后，唯一原因是"扩展也能声明 mcp 能力槽"。这是**加法关系不是依赖关系**：S6 落地后只是给 MCP 工具多一个来源。
   - 相比之下 S7（子代理）要真正有用，需要子代理消息树的前端视图（挂 `parent_tool_call_id`），是一整块 UI 工作；S6（扩展宿主）是 1–2 周的平台工程。两者都比 MCP 重、比 MCP 晚见收益。
   - **如果你更想要子代理或 Git 面板，把 T9 换掉即可**——T9 与 T6/T7/T8 之间只有单向依赖（T9 依赖 T7 的槽位），换掉不影响其余任务。

---

## 3. 执行契约

**完全沿用 `../r1/00-overview.md` §1**（硬性流程、硬性边界、TypeScript 约束、代码风格、已知坑）。开工前必读那一节。这里只复述最容易被忘掉的三条：

- 一个 T 一个 commit；每完成一步跑 `pnpm typecheck && pnpm test`，**不绿不进下一步**。
- 只改 spec 「涉及文件」清单里的文件；要动清单外的，停下来说明原因。
- 标 `【测试先行】` 的步骤先写测试并确认它 **RED**，再写实现。

R2 追加四条：

1. **不要用补丁修架构问题**。本轮多个任务的本质是"同一个概念散落在多处"（provider 支持列表、模型槽位、工作区根、审批归属）。修法是**收敛到单一事实源然后删掉旁路**，不是在旁路上加 if。如果你发现某处改不动是因为旁路太多，停下来报告，不要加第三条旁路。

2. **命名要形象**。函数名说清"它对什么做了什么"：`resolveWorkspaceForSession` 好过 `getWs`；`assertPathInsideWorkspace` 好过 `checkPath`；`deriveSessionStatus` 好过 `getStatus`（`derive` 传达了"这不是存储字段"）。文件名同理：`provider-catalog.ts` 好过 `constants.ts`。

3. **删东西要给实证**。本轮要删的死代码在 §1.3 D6 里逐条列了。删之前用 `grep -rn "<符号>" --include="*.ts" --include="*.tsx" apps packages tests` 复核一遍零调用方，把 grep 结果贴进 commit 正文。发现有调用方 → 停下来报告，不要硬删。

4. **新增的 FINDINGS 条目继续写进 `../r1/FINDINGS.md`**（同一个文件，不要新建 r2/FINDINGS.md——一个仓库一本流水账）。标签用 `[done in T10]` / `[r3]` / `[wontfix]`。

---

## 4. 验收总表

| 任务 | 一句话验收 |
|---|---|
| T5 | 审批卡片挂起时点"停止"→ 卡片立刻变成已拒绝、run 立刻结束（不是等 5 分钟）；两个会话各自只看到自己的待审批；`RunRegistry` 不再持有 sessionId |
| T6 | 在 UI 里点"添加工作区"选一个本地仓库 → 该会话的 agent cwd 就是它、能读写文件、`CLAUDE.md` 出现在 system prompt；换会话可换工作区；overflow 文件落在 `~/.eva/tool-overflow/` 而不是用户仓库；`TARGET_REPO_ROOT` 已从代码中消失 |
| T7 | `ProviderType` 的每个成员都能在 `provider-catalog.ts` 找到 spec 并被 runtime 真正支持（不支持的类型已从枚举里删掉）；embedding 配置走 `providers` 表 + `settings.models.embedding`；`settings-store.ts` 已拆成若干 <300 行的文件；模型 id 一律 qualified，无前缀猜测 |
| T8 | 侧栏能看到会话是 idle / running / requires_action；聊天页能看到本会话 token 累计与上下文占用比；compact 后的摘要是 LLM 写的（模型不可用时回落确定性拼接且日志说明） |
| T9 | 配一个 stdio MCP server（如 filesystem）→ agent 能调用 `mcp__filesystem__read_file`；server 连不上时 run 照常跑（日志有 warn）；MCP 工具默认需审批 |
| T10 | `sessions` 表无死列、`provider-models.ts` 与两张缓存表已删、`AppSettings` 每个字段都有读取方；`/settings/providers` 直链能打开对应 tab；`AGENTS.md` 里每个环境变量、每条路由、每个目录都能在代码里对上 |

---

## 5. R3 展望（不在本轮，不写详细 spec）

按价值/依赖排序，施工图已在 `docs/architecture/` 里：

| 任务 | 施工图 | 一句话 |
|---|---|---|
| S4 收尾 · per-tool 审批白名单 | `14` §4.4 | "始终允许"从全局开关改成 per-tool 记忆；bash 危险命令模式标注进审批卡片 |
| S6 扩展宿主 + 4 个 UI 槽 | `09-extension-host.md` 全篇 | manifest/exposes 双文件契约 + EH 懒激活 + 能力槽只改数据来源 |
| S9 Git review 面板 | `09` §13 + `03` | 做成 S6 的第一个真实扩展（不做 hello-ext） |
| S7 子代理 fork-join | `08-parallel-multi-agent.md` 全篇 + `14` §4.5 | Task/TaskOutput 双原语 + `background_tasks` 表 + 四道成本阀 + 子代理消息树视图 |
| S2 收尾 · 版本树前端 | `14` §7.2 | `parent_id/slot_id/depth` 数据地基已在 T1 打好，缺重新生成 / 版本切换 UI |
| S11 桌面化补完 | `02-electron-desktop.md` | updater / 托盘 / Alt+Space / `eva://` / 单实例锁 / 签名公证 |
| S12–S17 | `05-memory-subsystems.md` | 记忆文件三层、人格、心跳等 Phase E flavor，与主线正交 |

R2 明确**不做**的（防范围蔓延）：docs 14 §5.3 的三级投递台账、§5.5 late-arrival 窗口、§5.6 pessimistic-then-commit 探活、MCP 的 OAuth 授权流。前三条在单进程 + HTTP 直达的形态下收益远小于复杂度（理由见 `../r1/T4-cleanup-and-docs.md` §3）；第四条见 `T9-mcp.md` §0。
