# 16 · Alma v2 增量调研总览（v0.0.175 → v0.0.990）

> 调研对象：Alma v0.0.990（2026-08-21 构建），主进程+后端 bundle 经两轮美化后约 10.78 万行。
> 一手证据：`/tmp/alma-extract/main.readable.js`（下文一律简写为 `main:NNNNN`，行号已逐条 grep 验证）；路由清单 `/tmp/alma-extract/routes-all.txt`（497 条）；建表原文 `/tmp/alma-extract/tables-all.sql`（48 普通表 + 2 虚拟表）。
> 本文是 v2 增量调研（17–21 篇）的入口：回答三件事——**旧文档哪些还能信、v2 到底多了什么、Eva 该抄哪些**。
> 细节规格不在本文展开，每个子系统指向 17/18/19/20/21 对应章节。

**一句话概括这次升级**：v0.0.175 是一个「聊天助手 + Provider 管理 + 记忆」的应用；v0.0.990 长成了一个「带工作区/预览/git/多通道/云同步的 agent 操作系统」——以 workspace 为锚点（64 条路由 + 内嵌 git 客户端 + preview server + 内嵌浏览器），以 `alma://` 引用图谱为粘合剂，以 channel_mappings 接入外部 IM，以 plugins/hooks/prompt-apps 构成扩展面。路由从 404 条膨胀到 **497 条**（`/tmp/alma-extract/routes-all.txt`），WS 上行从 `{type:"message"}` 换成 `generate_response`（main:85384-85386），下行流式从「AI SDK chunk 原样转发」换成**自研 part-diff 增量协议**（`message_delta`，7 种 delta，main:73155-73284）。

---

## 1. 不变的主干（旧文档仍然成立的判断）

以下判断在 v0.0.990 bundle 中逐条复核过，**旧文档这些页可以继续信**。每条给出旧文档出处和 v2 复核证据。

| 旧文档判断 | 出处 | v2 复核证据 |
|---|---|---|
| **入口是 WS `generate_response`，不是 REST POST**；聊天链路全走 `/ws/threads` 双向协议 | 04 §8.1 | `/ws/threads` 分发（main:85366）；`generate_response`/`steer_generation` 判定（main:85384-85386）；连接首帧仍是 `generating_snapshot`（main:85370-85372） |
| **agent loop = AI SDK `streamText` + `stopWhen` 驱动**，SDK 管步骤循环，Alma 只管组装与消费 | 04 §2.1 / §8.4 | streamText options 对象组装（main:90607-90610 起，`{model, instructions, messages, allowSystemInMessages: !0, ...}`）；`stopWhen` 三条件（步数上限 100 / Gemini `AttemptCompletion` / steering 到达）；导入表 `streamText as we, stepCountIs as be`（main:120-133） |
| **UIMessage 整包落库、读写零转换**；历史直接喂回 SDK | 03 §4.3 / 04 §8.2.1 | `chat_messages.message` 仍是完整 UIMessage JSON；v2 只加了 `parent_tool_call_id` 一列挂子代理消息树（drizzle schema main:861-881） |
| **版本树三件套**（`parent_id + slot_id + depth` + `activePath/savedTails`）支撑重新生成/切换/分支 | 09 §3 | schema 三字段原样保留（main:861-881）；`replaceMessageId` 继承被替换消息的 parentId/slotId/depth 的 replace 语义仍在 |
| **SQLite 单库 + WAL + busy_timeout** | 03 §7.5 / 09 §2 | 主库仍只有 `chat_threads.db` 一个（main:2683-2685）；连接参数原文：`journal_mode = WAL / busy_timeout = 5000 / foreign_keys = ON / synchronous = NORMAL / cache_size = -64000 / temp_store = MEMORY`（main:2690-2696） |
| **文件即记忆/人格**：SOUL.md、MEMORY.md、每日笔记注入 system prompt | 05 / 04 §6.1 | 注入段仍在：`~/.config/alma/` 下 `SOUL.md / USER.md / MEMORY.md / memory/YYYY-MM-DD.md`（今+昨两天），全局配置目录自述原文见 main:89276 |
| **子代理 = 递归的同一条 loop，final answer 是唯一出口**，中间过程不进主上下文 | 08 §3 | 子代理跑自己的 `streamText`，主 agent 只收结构化结果 `{taskId, status, result?, error?}`；v2 新增的是任务持久化（见 §2 表） |
| **绑定 loopback 即信任边界，HTTP 面无鉴权 token** | 04 §5.2 | 仍只 `listen(port, "127.0.0.1")`；仅 chrome-relay/mobile-relay/browser-relay 三个 WS 用 token（main:85541 附近）。`server:get-port`/`get-auth-token` 旧推测仍不成立 |
| **编排模式沉淀为 skill，主循环不加编排代码** | 08 §5 | plan-weave / plan-mode / scheduler 全是 bundled skill（`/Applications/Alma.app/Contents/Resources/bundled-skills/*/SKILL.md`，实数 37 个），状态存文件或 DB |

**⚠️ 三条旧判断已被 v2 推翻**（按 09/03 原文逐条核对，避免再拿旧页当规格抄）：

1. **「流式不落库，onFinish 一次性 INSERT」过时**（09 §2.2-b、§8 checklist 第一条）。v2 是**流式防抖增量落库**（首帧即写、后续节流补写，`skipFtsIndex:true` 跳过中途 FTS，main:91183-91221）+ 结束终写。崩溃后能看到半成品消息。09 篇「别做 checkpoint」的哲学判断（重跑一次成本确定）仍然成立，但「中途不写库」这个实现事实不再成立。
2. **「崩溃不续跑、整轮作废重生成」过时**（09 §1、§8「别做」表）。v2 改为**自动续跑**：`resetStuckGenerations`（启动把 `is_generating=1` 归零）+ `resumeInterruptedTasks`（向自己的 `/api/chat/completions` 注入 `[System: The app was restarted mid-task...]` 让模型自续）；子代理可从 transcript 恢复（见 §2「子代理持久化」）。
3. **「记忆检索 = 向量 + FTS 混合 RRF」不成立**（05 §2）。v2 bundle 全文 grep `rrf|reciprocal|bm25|hybrid` **零命中**。记忆检索是**纯 vec0 余弦 KNN + 元数据后置过滤**，SQL 原文：`SELECT memory_id, 1 - vec_distance_cosine(embedding, ?) as score FROM memory_embeddings WHERE score >= ? ORDER BY score DESC LIMIT ?`（main:2186-2190）；FTS5 只服务于历史消息搜索，与记忆检索不融合。中文检索靠 LLM 查询改写（统一转英文）补齐。**Eva 的混合检索（13 篇记为「比 Alma P0 还完整」）这条结论要修正：Eva 是领先于 Alma 的设计，不是对齐 Alma。**

---

## 2. 新增/剧变一览表

按子系统分组。每行：一句话是什么 → 证据 → 详细规格去哪篇看。行号均指 `main.readable.js`；skill 路径省略前缀 `/Applications/Alma.app/Contents/Resources/bundled-skills/`。

### 2.1 Agent 内核与执行（→ 17 篇）

| 子系统 | 是什么 | 证据 | 详见 |
|---|---|---|---|
| **prepareStep 三路干预** | 步中动态干预上下文：① ToolSearch 结果里的工具 id 动态并入 `activeTools`；② Gemini 文本模型未收尾时注入 AttemptCompletion 提醒（≤3 次）；③ **AutoCompact** 步中溢出当场压缩 | main:90674-90680（prepareStep 入口）、90685（ToolSearch 分支）、90708-90737（Gemini）、90738-90824（AutoCompact） | 17 |
| **AutoCompact 三层防御** | 请求前预检（上条 assistant usage ≥ 阈值先压再发）+ 步中压缩（上条）+ 事后压缩；压缩产出 `<context_summary>` + system-reminder 双消息，目标 60% 窗口，保留最近 ≥4 条 user 边界；摘要指令原文在 main:71821（`DO` 常量） | main:43701-43715（溢出判定 `aA()`，输出预留上限 `32e3`）、90647（**上下文钳制**：模型报 token 超限则永久钳小其 contextWindow，日志原文 `[AutoCompact] ${S} rejected ${e} tokens — clamping...`） | 17 |
| **统一审批中心 `Sy()`** | 所有需用户点头的操作走一个 `Sy({source, title, ...})`；七级自动放行链（headless env → 全局自动批准开关 → 子代理一律自动 → 渠道无人值守 → 渠道 thread → cron → allow_always 记忆）；超时自动拒绝（默认 600s、硬上限 120s） | `async function Sy(e)` 在 main:27910；headless 分支 main:27911-27920；bash 先经 AI 风险分析器（本地规则 + 小模型，指令原文 main:33129-33160）再弹窗 | 17 |
| **run_script 沙箱 / PTC** | Programmatic Tool Calling：agent 写一段 TS/JS 在 bun 沙箱里跑，脚本内经 `almaTool(name,args)` 回调其他工具（走 `POST /api/tools/invoke` + 每会话 token），**中间结果留在沙箱不进上下文**，只回 stdout；默认开启（`settings.advanced.programmaticToolCalling !== false`），执行前必弹审批 | 开关判定 main:82015；schema `uA`（description ≤8 词 / code / timeout ≤600000）main:43733-43740；返回模型的话术原文："Only stdout is shown to you; N tool result(s) (~X tokens) stayed in the sandbox, saving ~Y context tokens."（main:82156） | 17 |
| **子代理 TaskManager 持久化 + resume** | 子代理任务从纯内存变为落盘 `~/.config/alma/tasks/tasks.json` + `logs/<taskId>.jsonl`；进程重启把 running 僵尸标 `completed`（error: "Process terminated on app restart"）并按 parentThreadId+parentToolCallId 自动 resume；resume prompt 模板原文见证据列 | 任务文件读写 main:25889-25933；resume prompt 原文（"You are resuming a previously interrupted task. Continue from the exact interruption point..."）main:84364-84378；`POST /api/agents/tasks/:taskId/resume` | 17 |
| **agent_missions/sprints/handoffs 多代理表** | Task 工具新增 `handoff.harness` 结构化交接包（goal/context/constraints/deliverable/acceptanceCriteria/writeBack + sprint 上限 20），对应 DB 五表，是 opt-in 的 Planner→Builder→Evaluator 流水线；失败 mission 可重开 | 建表原文：`agent_missions`（main:2754）、`agent_runs`（2757）、`agent_handoffs`（2760）、`mission_sprints`（2763）、`sprint_contracts/sprint_evaluations`（2766-2769） | 17 |
| **工具注册表 42 内置工具 + 安全网** | 静态表 `q$` 42 个工具（Bash/Read/Write/Edit/Glob/Grep/Task/TaskOutput/Skill/ToolSearch/WebSearch/WebFetch/Browser*/ChromeRelay*/widget*/AttemptCompletion/SlashCommand/AskUserQuestion）；**PM-011 不变量**：`activeTools` 未设且目录 >40 个时记 Sentry 并退化为最小集 | 工具表 main:43197-43244；安全网 main:90600-90606；工具结果序列化预算（maxSerializedChars 6000，字段级 head/tail 策略）main:25035-25075 | 17 |

### 2.2 工作区与编码工作流（→ 18 篇）

| 子系统 | 是什么 | 证据 | 详见 |
|---|---|---|---|
| **workspaces（64 路由）** | 最大新增组：工作区 CRUD + 文件树（含 SSH 远程读文件 base64 中转）+ preview server + 内嵌 git 客户端 + GitHub PR。thread 经 `workspace_id` 外键 N:1 挂工作区；另有 artifact 工作区第二外键 | drizzle schema main:783-814（含 `is_worktree/parent_workspace_id/worktree_branch/auto_worktree/pr_number/pr_url` 等列）；路由注册起点 main:77886 | 18 |
| **git 全套 30 路由** | shell 调系统 git（`execFile("git", args)`）：status/stage/diff/commit/log/branches/stash/worktrees/rebase 状态机 + `generate-commit-message` + **AI 解冲突**（`git show :1/:2/:3` 取 base/ours/theirs） | git 路由起点 main:77956；冲突内容提取 main:71280-71303 | 18 |
| **auto-worktree** | thread 首条消息时若 workspace 开了 autoWorktree 且是 git repo：自动 `git fetch` 探测 remote 默认分支 → 建 worktree 到 `~/alma/worktrees/` → 后台装依赖 → 把线程切到新 worktree → LLM 生成语义化分支名重命名 | main:88290-88420 | 18 |
| **preview server** | `preview_servers` 表（port/projectType/command/pid/status）+ `preview/start|stop|status|detect|html-files` + `/ws/preview/<id>` 状态推送 | schema main:1090；路由 main:77936-77956 | 18 |
| **session workspace 布局** | 每会话自动建目录 `~/Documents/Alma/<YYYY-MM-DD>/<slug>/{outputs,work,tmp}`，slug 由首条消息生成（可 LLM 辅助）；DB 行 `is_session=true, show_in_list=false` | main:6914-6981 | 18 |
| **iab（内置浏览器，32 路由）** | In-App Browser：绑定 workspace 的 Electron WebContents（Preview 面板 guest page），经 Electron debugger API（CDP 1.3）做全量浏览器自动化——导航/输入/读 DOM/截图/eval/上传下载/对话框/剪贴板/PiP 投屏；还能只读拷贝 Chrome History SQLite 查浏览记录 | `class ak`（IabManager）main:38160；`debugger.attach("1.3")` main:38175-38176；路由起点 main:74715；history 查询 main:75116-75208 | 18 |
| **terminal（node-pty）** | 内嵌终端：本地 node-pty 或 SSH `-t` 远程 PTY；scrollback 内存留 10 万字符，新 WS 客户端全量回放；`exec` 协议用 `__ALMA_S_<token>__/__ALMA_E_<token>__:<exitCode>` 标记从 scrollback 提取结构化结果 | 会话管理器 main:70052；路由 main:78129-78144；`/ws/terminal/<id>` main:85557-85592 | 18 |
| **remote-hosts（SSH）** | 远程主机表 + `~/.ssh/config` 一键导入 + ControlMaster 连接复用；remote workspace 的 bash/git/terminal/文件全走 SSH 包装（`buildRemoteShellArgs/buildRemoteGitArgs` 等模块面） | schema main:773-782；路由起点 main:77868；SSH 模块导出表 main:29584-29604 | 18 |
| **plan-mode / Plan Weave** | plan-mode 是纯内存全局开关（enter/exit，由 skill 驱动）；Plan 是 `<workspace>/.alma/plan/` 下的**文件型任务图状态机**：plan.json（tasks[].blocks[] 带依赖）+ state.json，核心循环 claim→execute→submit→review→feedback，review 达 maxReviewCycles 自动关门放行 | plan-mode 处理器 main:100874；plan 目录常量 main:43790；路由 main:78186-78202；skill：`plan-weave/SKILL.md` | 18 |

### 2.3 记忆与检索（→ 19 篇）

| 子系统 | 是什么 | 证据 | 详见 |
|---|---|---|---|
| **local-embeddings 1536 维迁移** | embedding 默认路径从本地 384 维翻转为**云端 OpenAI 兼容**（默认 `text-embedding-3-small`）；vec0 表维度跟着当前模型走——空表直接 DROP 重建，非空走 `rebuildEmbeddings`（试算首条定维度 → 批 10 重建 → `memory_metadata.embedding_model` 记账）；本地 384 维降级为 `__local__` 可选项（transformers.js，4 个 Xenova 模型） | vec0 定义 `embedding FLOAT[1536]` main:1793；`getEmbeddingProvider()` main:93161；`ensureVectorTableDimensions` main:1848；本地服务 main:24188-24360 | 19 |
| **memory_sleep 四层整理** | 后台定时（默认每天 03:00）四层归档管线：exact 去重 / expired 过期 / similarity 相似度聚类（≥0.95 直接归档）/ LLM 合并（≥0.75 进簇，批 20 条让 tool model 合成）；软删除进 `memory_archive`（含 reason/merged_into，可还原）；有 dry-run preview 与 token 计量 | `memory_sleep_runs` 建表 main:1802；管线 main:23668-23794；LLM 合并 prompt main:24140 | 19 |
| **每轮后台记忆提取** | 每轮 assistant 响应完成后后台提取：tool model 看最近 4 条消息产出 `{content, durability, operation: add|delete}`；ADD 先向量搜 5 候选再 LLM 判重；`metadata.memoryExtracted=true` 防重复 | main:91811-91829、87447 | 19 |
| **user_id 多租户命名空间** | memories 表 ALTER 增 `user_id` 列；渠道用户合成 `telegram:123` 形式；`people/<name>.md` 的 YAML frontmatter（`telegram_id` 等）做跨平台身份合并；检索/归档按命名空间隔离 | ALTER main:1836；身份合并 main:86559-86581 | 19 |
| **Activity Recorder（18 路由）** | 屏幕活动记录：ScreenCaptureKit（回退 desktopCapturer）截屏 + Swift 编译的输入监听器 + macOS Vision OCR；五路触发（heartbeat 120s/visual_change/click/app_focus/typing_pause）；OCR 文本正则脱敏（API key→`[REDACTED]`）+ 密码类 App 黑名单停录；session 经 tool model 分析出 `memoryCandidates` 反哺记忆库；日报/周报生成 | 采集器 main:66308-67200；五表 DDL main:2838-2853；脱敏 main:65640-65717 | 19 |

### 2.4 通道、sidecar 与同步（→ 20 篇）

| 子系统 | 是什么 | 证据 | 详见 |
|---|---|---|---|
| **多通道（discord/feishu/weixin/telegram）** | 统一抽象 `channel_mappings` 表把外部会话映射成内部 thread；入站经各 bridge → WS `generate_response`/`steer_generation` 回环驱动 agent，outbound 在 bridge 监听 `generation_completed` 发回平台。telegram 直连 Bot API、discord 用 discord.js、**feishu 是 spawn 外部 `lark-cli` 二进制**、**weixin 是腾讯 ilink bot HTTP 长轮询** | `channel_mappings` DDL main:2826；路由：groups main:75822、discord main:76004、feishu main:76302、weixin main:76494；lark-cli 查找/下载 main:59740-59900；ilink 端点 main:62244-62976 | 20 |
| **cloud-sync** | 极简单向快照：把 settings 全量写 `snapshot.json` 到 **iCloud Drive 本地目录**（`~/Library/Mobile Documents/com~apple~CloudDocs/Documents/AlmaSync`）；无拉取/合并/冲突逻辑 | main:69923-70013（`AlmaSync` 常量 main:69923）；路由 main:78163-78171 | 20 |
| **mobile-relay** | 手机远程接入中继：经 `https://relay.alma.now` 把本地 23001 整个 API 隧道到手机（桌面端收到 `hreq` 帧回环 fetch `127.0.0.1` 再流式回传）；OAuth 注册 + P-256 ECDH/AES-GCM E2E 可选；Capacitor 全家桶佐证 iOS 伴侣 App | 中继地址 main:72204；帧协议 main:20115-20176；路由 main:74333-74469 | 20 |
| **TTS python sidecar** | 双引擎：① sherpa-onnx 常驻 worker（bun 拉起 `tts-worker.cjs`，stdin/stdout 逐行 JSON `{id,lang,config,text}`→`{id,ok,pcm(base64),sampleRate}`，中文 melo-tts/英文 kokoro）；② Qwen3-TTS python sidecar（仅 Apple Silicon）：uv 装 Python 3.12 + venv + 拉 1.7B 模型，`tts_cli.py` 一次性 CLI 调用 | worker 拉起 main:21051；路由 main:76824-77398；sidecar 源码 `/Applications/Alma.app/Contents/Resources/tts/` | 20 |
| **chrome-relay（20 路由）** | 接管真实 Chrome：MV3 扩展 ↔ `/ws/browser-relay`（token 认证，失败 close 4001）↔ 主进程；扩展只暴露 7 个 method，click/type/read-dom 都是主进程侧组合 `cdp.send` 实现；read-dom 产出 `e1/e2...` ref→backendNodeId 快照 | 服务实例 main:41441；token 生成 main:42411-42430；扩展源码 `/Applications/Alma.app/Contents/Resources/chrome-extension/` | 20 |
| **computer-use（30 路由）** | macOS AX 桌面自动化：Swift 原生 helper（`Alma Computer Use.app`）以 unix socket daemon 运行（NDJSON `{id,cmd,args}` 协议，idle 900s 自退）；按 app bundle_id 的审批白名单表 + action log 审计；agent 侧双通道（MCP stdio server 自动注册进 mcp.json 首选 / `alma cu` CLI 兜底）；红线：绝不抢用户焦点 | socket 路径哈希 main:65867-65878；拉起 main:66200-66226；审批表 DDL main:2903 | 20 |
| **cron/heartbeat/fatigue** | cron 从 SQLite 迁到 `~/.config/alma/cron/jobs.json`（croner 驱动），**执行不直接跑 agent 而是 WS 回环发 `generate_response`**；heartbeat 是 HEARTBEAT.md 清单驱动的周期唤醒（`HEARTBEAT_OK` 静默抑制）；fatigue 是独立情感疲劳模型（每消息 +1.5/每分钟 -0.8 + 时段加成，四档状态注入 prompt） | CronService main:64251；heartbeat 默认配置 main:63586-63598；fatigue chunk `asar/out/main/chunks/fatigueService-CVpvjTys.js` | 20 |

### 2.5 扩展面与杂项（→ 21 篇）

| 子系统 | 是什么 | 证据 | 详见 |
|---|---|---|---|
| **refs（21 路由）** | `alma://` 双链引用系统：19 种 kind（thread/message/snippet/file/project/host/skill/agent/mission/plan/prompt/mcp/model/memory/artifact/tool/task/provider/cron）；消息内嵌语法 `@[label](alma://kind/id)`；`reference_links`（from_uri→to_uri）+ `reference_snippets` 两表支撑 backlinks/outlinks/graph；agent 经 `alma ref` CLI 反查 | kinds 数组 main:350-369；`reference_links` DDL main:2859；路由起点 main:47315；skill：`references/SKILL.md`（always-inject） | 21 |
| **plugins + plugin-themes** | VS Code 风格扩展宿主：manifest.json（Zod schema：id/name/semver/engines/type/permissions/contributes{tools,components,themes,providers,...}）+ Bun 编译 TS 入口（`bun build`，缓存键 sha256）+ 权限门控（`tools:register` 才能注册工具，命名 `<pluginId>.<name>`）+ safeStorage 加密 secrets；plugin-themes 把插件 colors 展开成完整 shadcn token 集 | manifest schema main:49521-49690；Bun 编译 main:49824-49877；路由起点 main:77824；plugin-themes 展开 main:49692-49735、77854 | 21 |
| **prompt-apps** | 「带表单的 prompt 模板」（轻 GPTs）：promptTemplate + placeholders 定义，模板替换**同时支持 `{{name}}` 和全角 `｛｛name｝｝`**；每次执行建新 thread（`chat_threads.prompt_app_id` 外键）并记 execution；可配独立小窗 + 全局快捷键 | schema main:729-764；`executePromptApp` main:95417-95465；路由起点 main:77712 | 21 |
| **hooks** | Claude Code 风格生命周期钩子：`~/.config/alma/hooks.json` 定义 `{event: [{matcher, hooks:[{command,timeout,enabled}]}]}`；`sh -c` 执行，stdin 收 JSON，**exit code 2 或 stdout decision=block 可阻断事件**；fs.watch 热载 | main:51462-51660；路由 main:77864-77867 | 21 |
| **usage 计量** | `usage_records` 表（每消息一行：input/output/cachedInput/cacheWrite/reasoning/total tokens + model + providerId + date）+ `GET /api/usage/stats` 按周期/provider/model 聚合并按定价表算 `totalCost`；旧数据后台迁移（`usage_migration_status`） | DDL main:2832（drizzle main:1373）；路由 main:78173-78180 | 21 |
| **rtk** | Rust 编写的 CLI 输出压缩器 sidecar：Bash 工具执行前把白名单命令（git/npm/pnpm/grep/rg/ls 等 22 个，无管道元字符时）改写为 `<rtk> <原命令>`，压缩输出省上下文 token；`GET /api/rtk/stats` 报节省统计 | 查找路径 main:24834；白名单起点 main:24858；改写 main:24897；路由 main:75704 | 21 |
| **people/groups/thread-labels/custom-themes/prompts** | people 是**文件型**画像（`~/.config/alma/people/<name>.md` + 平台 avatar，frontmatter 存 `telegram_id` 做身份匹配，无 DB 表）；groups 是 Telegram 群操作的 HTTP 封装；thread-labels/custom-themes/prompts 是小型 CRUD 表（labels 与 thread 的关联推测在 `chat_threads.metadata`，未确证） | people 路由 main:77673、注入自述 main:89276；labels schema main:1478；themes schema main:1356；prompts schema main:765 | 21 |

---

## 3. 对 Eva 的取舍建议

对照 `docs/architecture/14-eva-architecture.md`（目标架构与不做清单）与 `docs/architecture/15-eva-execution-playbook.md`（当前关键路径 **S6 → S9 → S7 → S11**，已完成 S0/S1/S1.1/S2 地基/S3/S4 主体/S5/S8）。分三档：值得抄 / 明确不抄 / 推迟。

### 3.1 值得抄（结合 Eva 当前 S 阶段进度）

1. **S9 要抄 workspaces 的 git 集成——但只抄一个子集**。Alma 的 30 条 git 路由里，Eva 的 Git review 面板只需要：`status`（`--porcelain=v2 --branch` 解析）、`stage/unstage/stage-all`、`diff`、`commit`、`log`、`branches`、`generate-commit-message`（LLM 生成 commit message 直接利好面板体验）。**不抄**：rebase 状态机、stash、AI 解冲突（`resolve-ai`）、GitHub PR 六条（Eva 对内是 GitLab MR，走 `/mr` 能力，15 §4 S9 已写明）。auto-worktree 的决策链（探测 remote 默认分支 → 建 worktree → 切线程 → LLM 改分支名，main:88290-88420）**值得整个抄**，但推迟到 S9 之后的迭代（见 3.3-2）。
2. **S7 直接抄子代理持久化三件套**：① 任务落盘（Eva 已有 `background_tasks` 表设计，14 §7.2，比 Alma 的 tasks.json 更规整——**落 DB 不落 JSON**，但 Alma 的「重启把 running 僵尸标 failed/completed + 按 parentThreadId+parentToolCallId 自动 resume」要抄）；② resume prompt 模板原文（main:84364-84378，核心是「从中断点继续、把已完成的步骤当作已做、有副作用前先检查工作区现状」三条）；③ 输出契约 `{taskId, status, result?, error?}`（final answer 唯一出口，与 14 §4.5 完全一致）。
3. **审批中心升级到 Alma 的 `Sy()` 形态——S4 收尾时做**。Eva 已有 approval-gateway + `cancelByRun`，14 §4.4 已定「审批永远等人，不超时」——**注意 Alma 反而有 120s 超时硬上限，这是 Alma 为无人值守渠道做的妥协，Eva 不抄超时，保留 R6 的「永远等人」**。要抄的是：① `allow_always` 的 **thread 作用域 policy key**（`bash:thread:<id>:command:<完整命令>` / `:all`，main:28067-28100），比 Eva 现在的 per-tool 白名单细；② bash 命令的**本地规则快速分级**（安全命令枚举 vs 需批命令枚举，main:33129-33160 的 `Hb` 指令前半段是本地规则可抄，后半段「小模型二次判定」推迟）；③ `approvalDecision={action, reason, decidedAt}` 回写消息 part 随流同步。
4. **AutoCompact 的步中压缩补进 Eva 已有的 compact 三件套**。Eva 已有 proactive/reactive compact（15 进度表记为「超预期」），但 Alma 的 **prepareStep 步中压缩**（多步工具循环中途溢出当场处理，而不是等 turn 结束）和**上下文钳制学习**（模型报 token 超限就把它的 contextWindow 永久钳小，main:90647 日志）是 Eva 没有的两层。压缩产出格式（`<context_summary>` user 消息 + 「不要从头再来」system-reminder）和摘要指令的六段结构（Primary Request / Key Technical Concepts / Files and Code Sections / Errors and Fixes / Problem Solving / All User Messages，main:71821）可直接借用。
5. **tools 目录 >40 的安全网**（PM-011，main:90600-90606）。Eva 的 MCP 接入后工具数会失控，这条不变量（activeTools 未设时退化为最小集 + 记 warning）一行逻辑，值得在 S7 前补进 harness。
6. **usage_records 的完整 token 五元组 + cache_write**。Eva 已有 usage_records 表雏形（14 §7.2），对齐 Alma 的列（cached_input/cache_write_input/reasoning 分列，main:2832）+ `GET /api/usage/stats` 聚合即可，成本低、观测价值高。
7. **hooks（文件型生命周期钩子）——作为 S6 扩展宿主的低配前奏**。Alma 的 hooks.json（matcher 正则 + `sh -c` + exit 2 阻断，main:51462-51660）只有约 200 行实现，却覆盖了「用户想在工具事件上挂自定义逻辑」的 80% 场景。Eva 的 S6 是全量扩展宿主，可以先把 hooks 当作能力槽之外的轻量补充（甚至可以就是 S6 的一个内置扩展）。

### 3.2 明确不抄（对齐 14 §15 不做清单）

1. **iab 不抄，用 chrome-relay 路线**（也不抄 chrome-relay 本体）。Eva 的 server 是独立 UtilityProcess，没有 Electron WebContents 可 attach——iab 的整个前提（主进程内嵌 + `webviewTag`）在 Eva 的进程模型里不存在（14 §2）。浏览器自动化需求走 WebFetch/WebSearch 已有工具 + 未来 chrome 扩展经 HTTP 接入（14 §2 的「一套 API 服务所有客户端」已经为此留了位置）。
2. **多通道（discord/feishu/weixin/telegram）不抄**——14 §15 第 4 条已列「不做全能工作台」，v2 证据只是证实了这四家的实现成本（feishu 要养一个 lark-cli sidecar、weixin 要维护 ilink 长轮询），与 coding 平台主线正交。唯一值得记住的是 `channel_mappings` 表的设计（外部会话 ↔ thread 显式映射 + is_active 切换），将来 S16 做通道时直接用。
3. **cloud-sync 不抄**。Alma 的实现就是「写 settings 快照到 iCloud 目录」（main:69923-70013），Eva 的 settings 在 SQLite + 文件里，用户自己同步 `~/.config/eva/` 即可，不值得一个子系统。
4. **mobile-relay 不抄**。它本质是「把 loopback API 经中继隧道到手机」，直接违反 Eva 的信任模型（14 §12：loopback 即边界，远程暴露必须先 token+TLS）。
5. **情感疲劳/旅行/自拍等拟人化子系统不抄**（14 §15 第 4 条 flavor 清单已覆盖）。v2 证据显示它们在 system prompt 里占了相当篇幅（emotions/fatigue/travel/selfie/people 五段），对 coding agent 是纯 token 成本。
6. **Activity Recorder 不抄进主线**（14 §15 + 15 §6 S15「隐私敏感最慎，最后做」已定性）。v2 只是把它的隐私规格挖清楚了（OCR 脱敏正则、密码 App 黑名单、锁屏停录）——将来真要做 S15 时按 19 篇的规格做。
7. **prompt-apps / custom-themes / plugin-themes / people / thread-labels 不抄**。全是 Alma 的「个人助理」 flavor；Eva 的 prompts 表（14 已有 settings 体系）够用。
8. **rtk 不抄**。Eva 已有 tool-overflow 截断 + 落盘机制（14 §4.3 防线一），解决的是同一个问题（CLI 输出省 token），不需要再养一个 Rust sidecar。
9. **agent_missions/sprints/handoffs 五表流水线不抄**——它违背 14 §15 第 3/7 条（「不把编排写进主循环」「编排模式永远是 markdown skill」）。Alma 自己也把它做成了 opt-in（`handoff.harness.enabled`），说明这条路的投入产出比连 Alma 都心虚。Eva 的等价物是 plan-weave 式的 skill（见 3.3-4）。
10. **PTC / run_script 不抄**（至少不按 Alma 的形态抄）。Eva 的审批模型是「危险工具逐个批」，PTC 是「一批批一整个沙箱脚本」——里面的 `almaTool` 回调绕过了逐工具审批，与 14 §4.4 的闸门语义冲突；且 Eva 没有 bun sidecar。省 token 的需求由 tool-overflow + compact 覆盖。

### 3.3 推迟（值得做，但不在当前关键路径 S6 → S9 → S7 → S11 上）

1. **refs（`alma://` 双链图谱）**：设计极优雅（19 种 kind + 两表 + backlinks/graph），但它是一个「全局对象寻址层」，价值随子系统数量增长——Eva 现在只有 threads/workspaces/memories 三类对象可引，做了也是空转。**等到 S9（git 对象）+ S7（task 对象）落地后再评估**，届时 `eva://` 的 kinds 至少能凑出 thread/message/file/task/mcp/skill 六个。
2. **auto-worktree**：见 3.1-1，决策链值得抄但依赖 S9 的 git 地基，推迟到 S9 之后。
3. **preview server**：等 Eva 的 workspace 有「跑起来的东西」再说（S9 之后的编码工作流迭代）。Alma 的五条路由（start/stop/status/detect/html-files）+ preview_servers 表是现成规格。
4. **Plan Weave（文件型任务图）**：这是 3.2-9 的正面替代——claim→submit→review 循环 + 文件态 plan.json/state.json 完全符合「编排沉淀为 skill」的哲学。**推迟到 S7 之后**：它强依赖 Task 子代理（work packet 塞给子代理执行），S7 没有 resume 和后台任务之前做了也跑不动。
5. **terminal（node-pty）**：Eva 的 Bash 工具已够用；内嵌终端的价值在「用户自己也要敲命令」的场景，属于桌面化打磨（S11 同期再评估）。Alma 的 `__ALMA_S_/E_` exec 标记协议（main:70146-70200）是个巧思，届时可抄。
6. **TTS/STT sidecar**：15 §6 S17 已定性为 Phase E 可选。v2 新挖出的 sherpa worker 行 JSON 协议与 Qwen3-TTS uv 流水线是现成规格，届时照 20 篇做。
7. **remote-hosts（SSH 远程工作区）**：与 Eva「本地优先」定位不冲突（workspace 本来就是个目录），但牵扯 SSH 连接复用、远程 git/bash 包装、文件 base64 中转一整层，**等 workspace 主链路稳定后再说**。
8. **记忆 sleep 整理**：Eva 记忆已「超预期」（15 进度表），sleep 是 Phase E 的 S12。Alma 的四层参数（0.95/0.75/30 天/批 20/簇上限 50）与软删除归档表结构已被 19 篇钉死，届时直接照抄参数。
9. **embedding 维度迁移机制**（`ensureVectorTableDimensions` + `rebuildEmbeddings`，main:1848/1884）：Eva 现在是本地 384 维，若将来要支持换 embedding 模型，这套「空表直接重建 / 非空试算首条定维度 + 批 10 重建 + metadata 记账」的流程要抄——但**Alma 把云端 embedding 设为默认这条不抄**（14 §11 反模式：不做云端记忆默认路径）。

---

## 4. 文档地图更新（17–21 各覆盖什么）

| 文档 | 覆盖 | 对应本文小节 |
|---|---|---|
| **17 · Agent 内核 v2** | streamText 参数全集、prepareStep 三路干预、AutoCompact 三层防御、42 工具注册表与工具预算、`Sy()` 审批中心、run_script/PTC、子代理 TaskManager 持久化与 resume、missions/sprints 多代理表、system prompt 组装新顺序 | §2.1 |
| **18 · 工作区与编码工作流** | workspaces 64 路由全集、session workspace 布局、git 客户端 30 路由、auto-worktree 决策链、preview server、iab（CDP 1.3）、terminal（node-pty + exec 标记协议）、remote-hosts（SSH）、plan-mode 与 Plan Weave 状态机 | §2.2 |
| **19 · 记忆与检索 v2** | 1536 维迁移与 rebuild、纯向量 KNN 检索（推翻 RRF）、每轮后台提取、memory_sleep 四层管线、user_id 命名空间、Activity Recorder 全规格 | §2.3 |
| **20 · 通道与 sidecar** | channel_mappings 统一抽象、telegram/discord/feishu(lark-cli)/weixin(ilink) 四桥、chrome-relay 协议、computer-use socket 协议、cron/heartbeat/fatigue 三件套、TTS 双引擎与 whisper、cloud-sync、mobile-relay 帧协议与 E2E | §2.4 |
| **21 · 扩展面与前端 v2** | refs（alma:// URI + 双链表 + 路由语义）、plugins（manifest schema + Bun 编译 + 权限）、plugin-themes/custom-themes、prompt-apps、prompts/hooks/usage/rtk/ptc、preload 44 namespace、窗口家族、WS part-diff 协议与前端 accumulator | §2.5 |

> 使用约定：17–21 与旧文档（00–15）是「增量修订」关系，不是替代关系。读任何主题先查本文 §1「不变的主干」确认旧页是否仍有效，再按 §2 表的指引进 17–21 对应篇拿 v2 规格。三处被推翻的旧判断（流式落库时机、崩溃续跑、混合检索）以本文 §1 末尾的勘误为准。

【全文完】
