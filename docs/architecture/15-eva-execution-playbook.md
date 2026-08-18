# 15 · Eva 执行手册：每个阶段做什么、怎么做

> 本文把 docs/architecture 全系列（00–14）收敛为一份**按 Eva 当前进度校准**的施工手册。
> 与 11 篇的关系：11 是"从空白起步"的落地计划；本文假设 Eva 现状（S0 完成、harness 已在 ai@7、S5 基本完成、审批/记忆/工作区有雏形），回答"**从现在起，每个阶段做什么、怎么做、照哪篇文档做**"。
> 每个任务给四件事：**做什么 / 怎么做（含文档出处）/ 验收 / 坑**。

---

## 0. 文档 → 任务地图（做哪块看哪篇）

| 文档 | 覆盖 | 喂给哪些任务 |
|---|---|---|
| 00 总览 | Alma 形态与设计哲学 | 全局 |
| 01 前端 | 流式三红线、虚拟滚动、状态管理 | S1.1、S7（子代理视图） |
| 02 Electron | 进程模型、IPC/HTTP 分工、updater、打包、安全 | S0、S11 |
| 03 后端+DB | 路由全景、WS 协议、SQLite schema、文件布局 | S2、S9、S10 |
| 04 模型适配+harness | AI SDK、agent loop、工具、审批、prompt、compact | S1、S4、S5、S8 |
| 05 记忆子系统 | 四层记忆、混合检索、sleep 整理、cron/心跳 | S12–S17（Phase E） |
| 06 复刻路线 | M 体系切片（已被 S 体系取代）+ 工程习惯 | 贯穿全程 |
| 07 扩展研究 | 12 个补充方向 | 优先级判断 |
| 08 并行多 agent | 并行 tool、fork-join、编排 skill 化、成本阀 | S7 |
| 09 扩展宿主 | manifest/exposes、槽位、EH、webview SDK | S6、S9 |
| 10 前端工程约束 | features/shared/slots 目录、命名、复用边界 | S1.1 起所有前端任务 |
| 11 落地计划 | S0–S17 任务拆分、验收、依赖图 | 全局（本文校准其进度） |
| 13 复用评估 | Eva 现状复用度、坑、决策 | 全局（本文引其现状） |
| 14 目标架构 | 12 条原则、Session/Run 领域模型、流式协议、不做清单 | S1–S7 的设计基线 |

---

## 1. 当前进度总览（代码实证，非 README 自述）

| 任务 | 状态 | 实证 |
|---|---|---|
| S0 地基 | ✅ 完成 | desktop fork server UtilityProcess + 动态端口 + 健康探测 + shell-env + 代理 |
| S1 harness 迁 SDK | ⚙️ 主体完成 | `ai@^7` + `@ai-sdk/anthropic` 在依赖里，`lead-agent.ts` 用 `streamText`；LangChain 手写 tool_call 重组已删 |
| S1 SSE 协议 | ❌ 未对齐 | 仍是自定义 `text_chunk / tool_call_start / tool_call_end / result / error / end` |
| S1.1 前端三红线 | ❌ 未达标（13 §4 实证） | 无 seq 字段直接 append；chunk 到达即全量 setState；Streamdown 全篇重解析；列表无虚拟化 |
| S2 存储+版本树 | ⚠️ 半 | `sessions/messages` 平铺表（role/content/searchText），无 UIMessage parts、无 parent/slot/depth |
| S3 工作区 | ✅ 完成（R2 T6） | `workspaces` 表 + 会话绑定 + per-run 注入 + CLAUDE.md 注入；TARGET_REPO_ROOT 已删 |
| S4 工具+审批 | ⚙️ 大部分在 | fs 工具组 + tool-overflow ✅；审批归属收敛到 run（R2 T5）✅；per-tool 白名单/危险命令标注待补 |
| S5 Skill | ✅ 基本完成 | loader/parser/prompt/read-skill-tool 三级渐进披露 |
| S6 扩展宿主 | ❌ 缺失 | 无 manifest/exposes/EH/slots |
| S7 子代理 fork-join | ❌ 待重建 | R1 T4 摘掉半成品,Task/TaskOutput 未建 |
| S8 MCP | ✅ 完成（R2 T9） | `mcp_servers` 表 + stdio/http client + `mcp__server__tool` 注册 + 审批默认开 |
| 记忆系统 | ✅ 超预期 | DB + sqlite-vec + FTS5 + query rewriting 混合检索（13：比 Alma 05 P0 还完整） |
| compact | ✅ 超预期 | in-loop proactive/reactive + session_compactions 持久化（R2 T8 起摘要用 tool 槽位模型） |

> **改因（R2 T10）**：进度按 R1+R2 实际完成情况重算。S8（MCP）提前到 S6/S7 之前的理由
> 见 `docs/plans/r2/00-overview.md` §2.1。

**结论：Eva 完成 Phase A（S3/S4 主链）。剩余关键路径：`S6 → S9 → S7 → S11`。**

---

## 2. Phase A · 能用（当前所在）

目标：一个能干活的 coding agent 雏形——流式顺滑、历史可靠、有工作区、工具受控。

### S1 收尾 · SSE 协议对齐 + abort（3–4 天）

**做什么**
1. harness 迁移收尾验证：`pnpm typecheck && pnpm test` 全绿，grep 确认无 `@langchain` 残留。
2. SSE 事件切换到 AI SDK chunk 命名（14 §6.1）：`text-delta / reasoning-delta / tool-input-start|delta|end / tool-call / tool-result / step-start / finish / error`；自有域（`approval_request / approval_resolved / subagent_update / session_status`）与 SDK 命名空间隔离。
3. 增量合流纪律（14 §6.2）：coalesce 窗口 ~100ms 批量发 + 首 delta microtask 立即发；tool input 用 partial-json 解析 + 增长门槛（64B / len/8）+ 500ms stall 逃生门；settle 帧永远带全量 value 作收敛点。
4. abort 链路（13 坑11）：run 级 `AbortController` 注册表 + 用户 stop / SSE 断连触发 abort；abort 只停主 loop，不杀后台任务。

**怎么做**
- 后端：`runs.ts` 里 `streamText(...).fullStream` 的 chunk 原样写 SSE，**不加中间表示**（04 §1.4"直接转发 SDK chunk"是 Alma 实证最优解）。
- 事件契约类型进 `packages/shared`（web/server 共用）。
- 常量集中进 `constants.ts` 并注释取值理由（14 原则 12：coalesce 100ms / stall 500ms / overflow 阈值……）。

**验收**
- [ ] `curl -N POST /api/v1/runs/stream` 看到的事件名与 AI SDK chunk 类型逐一对齐
- [ ] 生成中调 abort → 流立刻停，assistant 消息以 ABORTED 终态落库
- [ ] `pnpm typecheck && pnpm test` 绿；无 langchain 依赖残留

**坑**
- compression/缓冲中间件不能包住 SSE 路由，否则流被憋死（02 §9.5）；SSE 要 `flushHeaders()`。
- 自定义旧事件与前端耦合深，切换时前后端必须同 PR 落地。

### S1.1 · 前端流式三红线重写（1 周，与 S1 收尾同 PR 或紧随）

**做什么**（13 §4 判定"全部未达标，必须重写"）
1. **seq 重组**：SSE 事件带 `seq`；`shared/streaming/delta-accumulator.ts` 实现"seq≤last 丢弃、seq>last+1 进 pending 等缺口"（01 §3.2 ①）。
2. **rAF 字符泵**：`shared/streaming/use-smooth-stream.ts`——真实全文存 ref、屏幕只显示 displayed、每帧按 EMA(α=0.15) 跟踪的 CPS 放字符、积压 4s 加速清完、surrogate pair 对齐（01 §3.2 ②）。
3. **markdown 分块 memo**：`shared/markdown/markdown.tsx`——Streamdown 按块切分 + 每块 memo，只有尾部未完成块重解析（01 §3.2 ③）。
4. **消息列表虚拟化**：`@tanstack/react-virtual` + stick-to-bottom（距底 48px 内自动滚底，01 §3.1）。
5. **目录重构**：pages/components/hooks 层式 → `app/ + features/threads/ + shared/streaming|markdown|api|types`（10 §2/§3）；`types/api.ts` 相对路径 re-export 改 `@eva/shared` 别名（13 §5）。

**怎么做**
- 照 01 §7 最小骨架 + 10 §6 归属表：三红线全部进 `shared/`（S7 子代理视图要复用，埋 threads 里就是结构债）。
- 前端渲染单元 = UIMessage parts（text/reasoning/step-start/tool-\*），为 S2 的 UIMessage 整存提前对齐。
- 现有可复用资产保留为 features 起点：`sidebar.tsx / tool-call-block.tsx / chat-input / api/fetch.ts`（13 §4）。

**验收**（11 S1 + 01 §7 红线，缺一不是 Alma 体验）
- [ ] 打字→流式出字无顿挫；token 突发到达不卡（只尾块重渲）
- [ ] 手动断流重连，内容连续不丢不重（seq 重组验证）
- [ ] 长对话（100+ 消息）滚动流畅（虚拟化）
- [ ] 目录符合 10 §2；renderer 无 `node:` import（lint 强制）

**坑**
- 乱序是常态不是异常：accumulator 必须先写 pending 缓冲逻辑再写 append（01 §7 红线 1）。
- setState 只替换单条 message 引用，不全量重建数组（01 §3.2 ①）。

### S2 · 落地存储 + 版本树 + 会话运行时（1 周，Phase A 的枢纽）

> 14 §5/§7 的全部设计在这个任务落地。它是后续 S7（子代理消息树）、断线续传、版本重生的地基。

**做什么**
1. **消息模型重构**（03 §4.1/§4.3）：`chat_messages(id, thread_id, parent_id, slot_id, depth, parent_tool_call_id, role, message TEXT★, metadata, created_at)`，`message` 列存完整 UIMessage JSON；索引 `(thread_id)` / `(thread_id, timestamp, slot_id)`。
2. **版本树三件套**：`parent_id + slot_id + depth` 支撑重新生成/版本切换/分支；API `POST /messages/:id/switch-version`；前端版本切换 UI（10 §11）。
3. **Session/Run 领域模型**（14 §5.1–5.4）：Run 提为一等概念；`session.status` 改 `deriveSessionStatus()` 纯派生（requires_action > running > waiting > idle）；三级投递台账（accepted→started→claimed）+ `owedInput` 派生量；turn 懒开启；STREAM_END=status→idle 唯一边 + watchdog 复查。
4. **落库时机**：`onFinish` 拿到完整 assistant UIMessage 才落库 + 写 `usage_records`；流中途只推送不落库（03 §7.4）。
5. **断线续传**：重连后 `GET /threads/:id/messages` 全量对齐；`is_generating` 标志恢复生成态。
6. **late-arrival 窗口**（14 §5.5）：run finalize 后 5s 槽位承接迟到 tool_use/tool_result，debounce 重发 onRun 补偿持久化。
7. 数据迁移：开发期直接清库重来（本地优先，无线上数据负担）；写迁移 SQL 进 drizzle migrations。

**怎么做**
- UIMessage 类型契约进 `packages/shared`，server repository、web 渲染、harness 输出三方共用同一份类型——这是"整存零转换"的前提（03 §4.3）。
- 派生状态 = getter 不是字段：凡是能算出来的（status、owedInput、contextUsage）一律不写库（14 原则 8）。

**验收**（11 S2 + 14 §5）
- [ ] 重启后历史还在；重新生成同一提问得到新版本，前端可切换
- [ ] DB 里 `message` 列 `JSON.parse` 后顶层是 `{id, role, parts[]}`
- [ ] 审批 pending 时 session 派生态 = requires_action；后台任务活着时 = waiting 且不被回收
- [ ] abort 后迟到的 Write 结果在 5s 窗口内仍被持久化（可测：abort 瞬间触发写文件工具）

**坑**
- WAL 必开（03 §7.5）；整存不拆子表（part 级检索靠 FTS5/JSON 函数补）。
- 版本树索引漏建 `(thread_id, slot_id)` 会让版本查询全表扫。

### S3 · 项目工作区（3–4 天）

**做什么**
1. `workspaces` 表（03 §4.1：id/path/name/is_temporary/is_worktree/...）+ 导入本地 repo 流程。
2. agent 执行上下文绑定 workspace：fs 工具的 cwd = workspace.path；`resolve-workspace-path`（现状已有）统一做根目录前缀校验。
3. `CLAUDE.md` / `AGENTS.md` 注入 system prompt（04 §6.1 第 6 段：工作区文件快照）。
4. 前端 `features/workspace/`（10 §3）：导入入口 + 当前工作区展示。

**怎么做**
- 在现有 `services/workspace/` 雏形上补 DB 驱动；thread 表加 `workspace_id` 外键。
- prompt 注入走 prompt-builder 的 section 机制（现状已有 sections/），新增 `workspace-docs` section。

**验收**
- [ ] 导入一个本地 repo；agent 的 cwd = workspace.path，文件工具在其目录干活
- [ ] workspace 有 CLAUDE.md 时内容出现在 system prompt 里
- [ ] 路径穿越（`../../`）被工具拒绝

### S4 · 工具 + agent loop + 审批补齐（3–4 天）

**现状**：fs 工具组 + tool-overflow ✅；审批表/gateway/UI ✅。

**做什么**
1. **审批语义对齐 InteractionBroker**（14 §4.4）：deferred promise 桥；`resolve=allow / reject=hard deny`；abort/run 结束/destroy 时 `cancelAll` 统一 reject；session 派生态联动 requires_action；"始终允许"写 per-tool 白名单（settings）。
2. **parallelToolCalls 策略**（08 §2）：主 agent 透传开启；子代理/受控上下文强制关（Alma `Lt` 闸门）——这是 S7 的前置。
3. **Bash 工具补强**：超时、大输出 tool-overflow（已有）、危险命令模式标注进审批卡片。
4. **step-start 可见**：多步工具循环在前端按 step 分组渲染（04 §2.1）。

**怎么做**
- 审批 = 高阶函数包在危险工具 execute 外层（04 §7 代码 5），不侵入工具本体。
- broker 通知回调全部 try/catch（14 §4.4，WeaveLynx `#safeChange` 教训）。

**验收**（11 S4）
- [ ] "在我工作区建 hello.txt 写首诗"→ 真建了；Bash/Write/Edit 先弹审批，允许才执行
- [ ] 审批挂起时 abort → pending 审批全部 reject，不永远吊着
- [ ] 超长 Bash 输出落盘 tool-overflow，消息里只有摘要+路径
- [ ] agent loop 多步调用可见（step-start part）

---

## 3. Phase B · 像平台（S5–S8）

目标：可扩展的多 agent 平台——skill 热插拔、扩展槽位、fork-join 子代理、MCP 接入。

### S5 · Skill 机制收尾（1–2 天验收）

**现状**：三级渐进披露已实现（✅ 基本完成）。

**做什么**
1. 走查验收（11 S5）：手写一个"天气 skill"（SKILL.md 含 curl 模板）放 skills/ 目录；确认 system prompt 的 `<available_skills>` 只注 name+description；问天气 → agent 调 Skill 工具读全文 → 照做。
2. skill 管理 UI：`features/skills/`（10 §3），启用/查看 SKILL.md，复用 `shared/markdown/` 预览。
3. **编排模式 skill 化**（14 §4.6）：把 council/gan-harness 写成 SKILL.md 放进 bundled skills——主 loop 不加一行编排代码（08 §5）。

**验收**
- [ ] `<available_skills>` 只含元数据（不灌全文）；按需读全文；附属文件按需 Read
- [ ] 新增 skill = 写一个 Markdown 文件，不改代码

### S6 · 扩展宿主 + 槽位（1–2 周，Phase B 主战场）

**做什么**（09 全篇是本任务的施工图）
1. **契约层**：`manifest.json`（身份 + contributes）+ `exposes.json`（槽位映射 + API + 权限），zod schema 校验（09 §3.4）——**校验先于任何扩展代码执行**。
2. **EH 后端**：`ExtensionHost` 类起步为主进程内隔离模块（不拆进程）：Loader 扫描校验预填注册表 → Activator 懒激活（用到槽位/能力才 activate）→ 不可变 Registry → PermissionGuard（09 §4）。
3. **4 个 UI 槽容器**：`slots/app-sidebar|chat-composer|chat-header|chat-sidebar-slots.tsx`（10 §5），MVP 用 iframe 挂扩展产物，后续升 BrowserView。
4. **webview SDK bridge**：preload 注入 `window.host`（context/invoke/ui/on/emit），槽位上下文从 URL query 来必须校验（09 §5.4）。
5. **agentPlugin 能力注入**：runAgent 的注入点（skills/tools/mcp/subagents）从"直接读 DB/文件"改"查 EH Registry"——**agent loop 一行不动**（09 §6）。
6. **DB**：`plugins` + `plugin_permissions` 表；REST `/api/plugins/*` + `/api/slots`（09 §8）。
7. **验收扩展直接做 S9 Git 面板雏形**（09 §13：别做玩具 hello-ext）。

**验收**（09 §11 三子切片）
- [ ] S6.1 静态槽位：扩展的 appSidebar 组件渲染；enable/disable 出现/消失
- [ ] S6.2 能力注入：扩展 skill 进 `<available_skills>`；agent 调用扩展工具
- [ ] S6.3 前后端通信：`host.invoke` 调到扩展后端；命令面板出现扩展命令；`host.ui.toast` 能弹

**坑**（09 §10，按概率排序）
- manifest/exposes 在执行扩展代码前必须 zod 校验通过；activate 抛错只标记 disabled 不崩宿主；懒激活防 20 扩展拖慢启动；webview 监听器必须返回取消函数；命名空间 `ext.<id>.<name>` 防冲突；权限在 EH 后端强校验，前端只做灰显。

### S7 · 子代理 + fork-join（1 周）

**现状**：registry/executor 同步骨架（无后台/无 resume/无 join）。

**做什么**（08 全篇 + 14 §4.5）
1. **双原语**：`Task`（`subagent_type/prompt/run_in_background/resume`）+ `TaskOutput`（`taskId/block`）。
2. **后台任务表**：`background_tasks(id, thread_id, parent_tool_call_id, status, result, error, transcript, ...)` 落库（14 §7.2）——后台异常必须写 `failed+error` 透出；join 带超时 + 超时返回 partial。
3. **四道成本阀**（08 §6）：子代理强制 `toolModel`；final answer 唯一出口（中间过程挂 `parent_tool_call_id` 消息树，不进主上下文）；`MAX_DEPTH` 硬闸 + `allowedDelegates` 白名单；子代理关 `parallelToolCalls`。
4. **resume**：transcript 不销毁，`Task(resume: taskId)` 带全部记忆续聊。
5. **终态收割 + ctx 信封**（14 §4.5）：进行中子代理不属于任何 run，终态后由观察到的 run 收编；子代理事件强制带 `{parentMessageId, parentPartId}`——**收敛到单一 emit 入口注入**（WeaveLynx 妥协 3 的教训）。
6. **可观测**：`GET /threads/:id/subagent-messages` 暴露子代理消息树；前端子代理视图**复用** `shared/streaming/`（10 §6 红线提升的回报）。
7. **前台默认**（08 §3.1）：引导文案照抄——"Prefer foreground execution…use run_in_background only when concurrency matters more than live visibility"。

**验收**（11 S7）
- [ ] 并行 fork 3 个后台子代理立即拿 taskId；逐个 `TaskOutput(block:true)` join 并综合结论
- [ ] 子代理用 toolModel（便宜档），主 agent 用 chat 档
- [ ] depth 超限拒绝委派；后台异常不吞（join 方见到 failed）；join 超时返回 partial
- [ ] 主对话里能点开看子代理完整过程

**坑**（08 §7 五坑，按踩中概率排序）：后台异常被吞 / join 无超时 / 并行写同文件 / 无深度限制 / 子代理开并行 tool。

### S8 · MCP 接入（3–4 天）

**做什么**（04 §4）
1. `mcp.json` + `mcp_servers` DB 表双来源；`@modelcontextprotocol/sdk` 客户端。
2. 工具动态注册为 `mcp__<server>__<tool>` 并入 tools 对象；工具列表先注册、schema 用时再拉（渐进披露）。
3. OAuth token 落 `mcp_oauth_tokens` 表。
4. 接 S6 的 mcp 能力槽：扩展声明的 mcp 并入 `loadMcpTools` 来源（09 §6）。

**验收**
- [ ] 配一个 MCP server（如 filesystem）；agent 调用 `mcp__filesystem__read` 成功
- [ ] 扩展经能力槽注册的 MCP server 同样可用

---

## 4. Phase C · 编码工作流（S9–S10）

### S9 · Git review 面板（1 周）

**做什么**
1. 做成**一个扩展**（09 §13：S9 = S6 的验收扩展）：挂 `appSidebar` + `chatComposer` 槽，注册 `git.diff/commit/push` 命令。
2. 后端能力：workspaces git 子路由（03：`/api/workspaces/:id/git/*`——diff/branch/commit/stage/worktrees）；前端 diff 视图。
3. worktree 隔离试改（03 workspaces 表的 `is_worktree/parent_workspace_id/worktree_branch` 字段就是为这个准备的）。
4. MR 创建（对内 GitLab：调 GitLab API，复用 `/mr` 类能力）。

**验收**
- [ ] 面板看未提交 diff；提交+推送+开 MR 一条龙
- [ ] worktree 隔离试改不污染主工作区

### S10 · 数据源 Gateway 抽象（1 周）

**做什么**（11 §4；WeaveLynx datasource 视角，无 Alma 对应）
1. 最小域抽象：`Datasource` 接口 = `query(input) → result`；两个实现域——database RPC + 外部 HTTP 代理。
2. AK/SK service credential 表（无登录用户场景：BFF/CI/脚本）。
3. agent 经 Gateway 工具查数据，不直连外部。

**怎么做**
- 本地优先下这是"预留接口缝"：抽象和本地实现在 Eva 内，协议设计允许未来把实现挪到服务端（11 §4 接缝说明）。
- 不过度设计：先 1 个真实数据源跑通（如一个内部 API），域模型跟着真实负载长，不预先铺 5 个域。

**验收**
- [ ] 注册一个外部数据源；agent 经 Gateway 查到数据；AK/SK 鉴权可用

---

## 5. Phase D · 成品（S11，可与 B/C 后期并行）

### S11 · 桌面化补完（1 周 + 持续）

**做什么**（02 全篇是施工图）
1. **自动更新**：electron-updater + generic feed（静态托管）或 GitHub Releases 免费 feed（02 §4/§9.6）；启动后 + 每 4h `checkForUpdates`；`update-downloaded` 后用户确认才 `quitAndInstall`（别在打字时自动装）。
2. **系统集成**：托盘（16×16 Template Image）、Alt+Space 全局唤起、`eva://` 深链、单实例锁（02 §9.8）。
3. **打包**：electron-builder mac arm64 单架构（砍 win target，13 坑5）；`asarUnpack` 覆盖 `**/*.node / **/*.dylib / **/*.wasm`（sqlite-vec 必须 unpack，02 §8.2 坑1）；Developer ID + hardened runtime + notarize。
4. **安全收口**：contextIsolation 开 / nodeIntegration 关 / sandbox 开（现状 preload 已合规，13 §7 坑8"preload 极窄够用"）；CSP 放行 `connect-src http://127.0.0.1:*`；评估 loopback token（02 §9.5：本地 HTTP 裸奔的公知风险——任何网页都能 fetch 127.0.0.1。renderer 经 preload 拿一次性 token，除 `/v1/health` 外全量校验）。

**验收**（11 S11）
- [ ] dmg 能装；启动后检查更新能拉到新版本
- [ ] 托盘 + Alt+Space 唤起；`eva://thread/xxx` 深链跳转；第二次启动聚焦已有窗口

**坑**（02 §8.2/§9.6/§9.8）
- mac 未签名包 `checkForUpdates` 静默失败——更新链路以签名包为前提；`open-url` 可能早于 ready，监听要挂模块顶层；`will-quit` 里 `unregisterAll` 快捷键；模型权重类大文件首启下载，不进安装包（否则安装包 GB 级）。

---

## 6. Phase E · 调味（按需，与主线正交）

> 全部来自 05/07。**任何时候不许挤占 S1–S9 的资源**（14 §15 不做清单第 4 条）。Eva 的记忆系统已超 Alma P0（13 §2：vec + FTS5 + query rewriting），所以 S12 是"对齐"而非"新建"。

| 任务 | 做什么 | 怎么做 / 文档 | 验收 |
|---|---|---|---|
| S12 记忆对齐 | 文件三层补全：`MEMORY.md` + `SOUL.md` 常驻注入、`memory/YYYY-MM-DD.md` 日记；会话结束写日记 hook；sleep 整理 cron（exact/expired/orphan/similarity/LLM 五类归档进 memory_archive，合并不删除） | 05 §8 P0 / §9 施工图；现有 vec+FTS 混合检索直接作 L4 | "我喜欢吃汉堡"明天新对话还记得；归档可追溯 |
| S13 人格/疲劳 | SOUL.md 人格 + fatigue.json（消息递增、时间衰减）翻译成情绪描述注入 prompt | 05 §5.3 | 疲劳高时回复更简短 |
| S14 Heartbeat | croner 定时唤醒，检查待办/回顾记忆/执行后台任务 | 05 §5.2 | 空闲时 agent 主动来找你 |
| S15 Activity Recorder | 定时截屏 + 前台窗口 + OCR + 活动切分，走同一条 embedding 管线 | 05 §4；**隐私敏感最慎，最后做**；本地处理 + 明确开关与排除规则 | "我昨天下午在搞什么"能答 |
| S16 多通道 | TG/Discord/飞书选一汇入统一消息管线 | 05 §7；channel_mappings 表 | 通道消息进同一 thread 模型 |
| S17 本地语音 | Whisper STT + 本地 TTS sidecar | 05 §6 | 离线语音对话 |

---

## 7. 贯穿全程的工程纪律（06 §贯穿 + 11 §10 + 14 原则 12）

1. **一切状态可读**：DB 能用 GUI 打开看；记忆/人格/技能是 Markdown 能直接读。80% 的调试就是"看一眼"。
2. **API 先行**：所有能力先暴露成 HTTP 路由，UI 只是消费者——CLI/扩展/未来移动端免费接入。
3. **Prompt 是代码的一部分**：system prompt 模板版本化，改动要 diff 评审。
4. **每个功能一个文档**：写完一个切片就更新对应章节（本系列就是这么来的）。
5. **实测常量集中管理**：coalesce 100ms / stall 500ms / late-arrival 5s / MAX_DEPTH / join timeout / overflow 阈值 / 记忆预算——收进 `constants.ts`，每个值注释"为何取此值"，配回归测试钉死；AI SDK 升级优先回归这组测试。
6. **完成定义不是"代码写完"**，是"验收全绿 + 无结构债"（11 §10）：
   - 每片 PR 过 10 §10 反模式检查 + feature 隔离 lint
   - 流式相关切片（S1.1/S7）当场验不顿挫、不丢不重
   - S6/S9 必须是真实扩展跑通，不是 hello world
   - 结构债不留下一切片（shared 提升及时、feature 裂化及时修）

---

## 8. 依赖图与下一步

> **改因（R2 T10）**：R1（S1/S1.1/S2/S4 主体）+ R2 已把 Phase A 收完，S8 提前落地（见
> `docs/plans/r2/00-overview.md` §2.1）。下面的图反映实际完成情况。

```
已完成：S0 ⚙️ S1 ⚙️ S1.1 ⚙️ S2 ⚙️ S3 ⚙️ S4(主体) ⚙️ S5 ⚙️ S8 ⚙️ 记忆 ⚙️ compact
   │                    │
   ├─> S6(扩展宿主) ──> S9(Git面板=S6验收)
   │       │
   ├─> S7(fork-join, 复用 shared/streaming 与 tool 槽位)

S11(桌面化) 可与 B/C 后期并行；S10 独立；S12–S17 全独立按需
```

**关键路径**（从现在起最短通路）：

```
S6 → S9 → S7 → S11
```

**下一步（S6 扩展宿主）**：见 09 全篇 + `docs/plans/r2/00-overview.md` §5。

---

## 9. 一页速查：每个阶段一句话

| Phase | 目标 | 任务 | 当前 | 做完的标准（一句话） |
|---|---|---|---|---|
| A | 能用 | S1 收尾 + S1.1 | 🔵 进行中 | 流式顺滑不顿挫，协议与 AI SDK 对齐 |
| A | 能用 | S2 | ⬜ | 重启历史在，版本可切换，UIMessage 整存 |
| A | 能用 | S3 / S4 | ⚙️ 雏形 | 导入 repo 干活；危险操作先审批 |
| B | 像平台 | S5 收尾 | ✅ 大半 | 写个 Markdown 就长出新能力 |
| B | 像平台 | S6 | ⬜ | 真实扩展（Git 面板）挂槽跑通 |
| B | 像平台 | S7 / S8 | ⚠️ 骨架 | fork 3 个子代理并行干活；MCP 工具可调 |
| C | 编码工作流 | S9 / S10 | ⬜ | diff→commit→push→MR 在面板完成 |
| D | 成品 | S11 | ⬜ | dmg 可装、自动更新、Alt+Space 唤起 |
| E | 调味 | S12–S17 | 可选 | agent 有记忆、有人格、会主动找你 |

【全文完】


