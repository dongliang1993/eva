# 19 · Alma v0.0.990 工具注册表 + Skill 手册 + Sidecar 目录

> 基线：Alma v0.0.990（2026-08-21 构建）。证据文件为 `/tmp/alma-extract/main.readable.js`（约 107,800 行美化后的主进程 bundle）、`/Applications/Alma.app/Contents/Resources/`（sidecar 与 37 个 bundled skills）。行号除特别注明外均指 `main.readable.js`。
>
> 本篇与旧版（v0.0.175）的对应关系：Part 1 对应旧 04 篇 §2「内置工具清单」，Part 2 对应旧 04 篇 §4「Skill 扩展机制」，Part 3 对应旧 02 篇的 sidecar 散落记录。凡与旧版冲突之处，以本篇行号证据为准。

---

## Part 1 工具注册表

### 1.1 全景：42 个静态内置工具 + 动态注入

内置工具的静态注册表是 `q$`（43197-43244，原文）：

```js
q$ = Gf({
    Bash: ov, BashOutput: rT, KillShell: aT,
    Read: Dv, Write: eT,
    get Edit() { return Om() ? Vv : Hv; },   // 按配置切换两种 Edit 实现
    Glob: vv, Grep: Sv,
    Task: fb, TaskOutput: Tb,
    Skill: lT, ToolSearch: aE,
    WebSearch: Bk, WebFetch: Jk,
    BrowserOpen: sS, BrowserClick: cS, BrowserType: uS, BrowserScreenshot: pS,
    BrowserRead: fS, BrowserReadDom: kS, BrowserBack: yS, BrowserForward: bS,
    BrowserReload: TS, BrowserEval: AS, BrowserClose: xS,
    ChromeRelayListTabs: jS, ChromeRelayNavigate: qS, ChromeRelayClick: YS,
    ChromeRelayType: VS, ChromeRelayScreenshot: e$, ChromeRelayRead: o$,
    ChromeRelayReadDom: i$, ChromeRelayEval: l$, ChromeRelayScroll: h$,
    ChromeRelayBack: w$, ChromeRelayForward: T$, ChromeRelayUpload: f$,
    widgetReadme: I$, widgetRenderer: R$, pieChart: P$, barChart: F$,
    AttemptCompletion: dE, SlashCommand: pT, AskUserQuestion: z$,
})
```

**静态表恰好 42 个**。在此之上还有四类动态工具源（工具装配函数在 82445-82498，最终合并 MCP + plugin 后交给 `injectPtcExecutor`）：

1. **run_script**（PTC 沙箱）——不在 `q$`，由 `injectPtcExecutor` 在 settings `advanced.programmaticToolCalling !== false` 时注入（82015-82030，默认开启）。
2. **渠道工具**：`YI`（emoji 回应，54397）与 `eC`（TTS 语音回复，54440），仅 Telegram 等渠道注入；`YI` 描述原文含 "Only works for Telegram"。
3. **MCP 工具**：`serverName__toolName` 命名（`getMCPToolSet()` 合并进工具集，82450/82496；命名证据见 ToolSearch prompt 37446 "use the full tool ID (e.g., \"serverName__toolName\")"）。
4. **插件工具**：`plugin--<pluginId>--<toolName>` 命名（前缀常量 `JT = "plugin--"`，37259；ToolSearch prompt 37446 同证）。

**相对旧版 04 篇 §2 的重要演进**：`TodoWrite`/`Recall`/`OperateMemory`/`ReadSettings`/`EnterPlanMode` 等名字在 v0.0.990 只剩 UI 归类（`gf` 折叠组，24988-25018）和自动选工具 prompt（49045 第 6/8/9 条）里的引用，**没有独立工具实现**——待办下沉为 `POST /api/todos` + WS `todo_update` 广播，记忆下沉为 `alma memory` CLI / memory-management skill，plan-mode 下沉为 `/api/plan-mode/enter|exit` REST。**状态型"工具"从 LLM tool 变成了 REST + WS + CLI 三件套，LLM 侧靠 Bash 调 CLI 触达**。这是复刻时最容易照错的一点。

### 1.2 按域分组的工具清单

下表「审批」列含义：✅=每次必经 `Sy()` 审批中心；条件=Bash 经 AI 风险分析后按需弹；其余=不弹审批。「schema 关键参数」取自各工具的 zod inputSchema。

| 工具 | 一句话功能 | 审批 | schema 关键参数 |
|---|---|---|---|
| **文件域** | | | |
| `Read` | 读文件；文本截 2000 行/50KB，图片转视觉内容（最长边 1600px）且 GUI 内联渲染 | 否 | `file_path, offset=1, limit?` |
| `Write` | 创建/覆盖文件 | 否 | `file_path, content, create_directories=true` |
| `Edit` | 结构化补丁改文件（两实现按配置切换） | 否 | `path, edits:[{op, pos, end, content}]`，pos=锚点行 |
| `Glob` | glob 找文件 | 否 | `pattern, path="."` |
| `Grep` | ripgrep 搜内容（输出带 `engine:"ripgrep"` 字面量，34377） | 否 | `pattern, path, glob?, type?, -A/-B/-C, head_limit, offset, output_mode` |
| **执行域** | | | |
| `Bash` | 执行 shell 命令；前台/后台双模式 | 条件（AI 风险分析→按需弹） | `command, description, timeout?≤600000(默认120s), run_in_background?=false` |
| `BashOutput` | 取后台 shell 输出 | 否 | `bash_id` 等 |
| `KillShell` | 终止后台 shell | 否 | `bash_id` |
| `run_script`（PTC） | 沙箱内跑 JS/TS，`almaTool` 回调其他工具，中间结果不进上下文 | ✅ 每次弹 | `description(≤8词), code, language?:ts\|js, timeout_ms?≤600000(默认120000)` |
| **子代理域** | | | |
| `Task` | 启动子代理（探索/规划/coder/受管专家） | 否（子代理内危险操作自动批准） | `description, prompt, subagent_type?, agent_id?, model?, resume?, run_in_background?, handoff?` |
| `TaskOutput` | 取后台/子代理任务结果 | 否 | `task_id, block=true, timeout≤600000(默认30000)` |
| **元/扩展域** | | | |
| `Skill` | 按名加载 skill 全文（渐进披露第二级） | 否 | `skill`（仅技能名，无参数） |
| `ToolSearch` | 小模型语义搜索可用工具（内置+MCP+插件） | 否 | `query, type="all", limit=20` |
| `SlashCommand` | 执行 `/pwd` `/ls` `/cat` `/todo` 等轻量斜杠命令 | 否 | `command`（须以 `/` 开头） |
| **网络域** | | | |
| `WebSearch` | 隐藏 BrowserWindow 渲染 SERP 抓结果，带 `[1][2]` 引用编号 | 否 | `query, allowed_domains?, blocked_domains?, max_results=5, include_markdown?` |
| `WebFetch` | 隐藏窗口渲染 JS → HTML→markdown → 按 prompt 抽取 | 否 | `url, prompt, max_bytes?≤2e6(默认2e5)` |
| **内置浏览器域**（自建可见窗口 + CDP） | | | |
| `BrowserOpen` | 开持久可见窗口并导航，跨调用存活 | 否 | `url` |
| `BrowserClick` / `BrowserType` | 按 CSS 选择器点击/输入（可选回车） | 否 | `selector, text, pressEnter=false` |
| `BrowserScreenshot` | 截图（`toModelOutput` 转成 image content block 给多模态模型） | 否 | 无参 |
| `BrowserRead` / `BrowserReadDom` | Readability 抽取 markdown / 列可交互 DOM 元素 | 否 | 无参 |
| `BrowserBack` / `BrowserForward` / `BrowserReload` | 历史/刷新 | 否 | 无参 |
| `BrowserEval` | 页面上下文执行 JS | 否 | `code` |
| `BrowserClose` | 关闭窗口回收资源 | 否 | 无参 |
| **Chrome Relay 域**（接管用户真实 Chrome，走 bundled 扩展） | | | |
| `ChromeRelayListTabs` | 列用户 Chrome 全部 tab | 否 | 无参 |
| `ChromeRelayNavigate` | 导航/新建 tab | 否 | `tabId?, url`（省略 tabId 则新建） |
| `ChromeRelayClick` | 按 ref（`e4`）或 CSS 点击；返回「实际点了什么」回执 | 否 | `tabId, selector, index?=0, allowHidden?=false` |
| `ChromeRelayType` | 输入并回报字段实际值/失败原因 | 否 | `tabId, selector, text, pressEnter=false` |
| `ChromeRelayScreenshot` | 截图（>1024px 在 mac 用 `sips` 缩到 1024 宽，全尺寸另存盘） | 否 | `tabId` |
| `ChromeRelayRead` / `ChromeRelayReadDom` | markdown 抽取 / ref 快照（`e1/e2…`） | 否 | `tabId` |
| `ChromeRelayEval` / `ChromeRelayScroll` | 执行 JS（Promise 会 await）/ 滚动 | 否 | `tabId, code` / `tabId, direction, amount=500` |
| `ChromeRelayBack` / `ChromeRelayForward` / `ChromeRelayUpload` | 历史 / 文件上传（`DOM.setFileInputFiles`） | 否 | `tabId` / `tabId, selector?, filePath` |
| **可视化域**（UI 渲染层，execute 只返回 `{rendered:true}`，真正的渲染在前端） | | | |
| `widgetReadme` | 返 widgetRenderer 设计指南（CSS/配色/排版，按模块加载） | 否 | `modules: enum[art,mockup,interactive,chart,diagram][]` |
| `widgetRenderer` | 在聊天气泡内渲染自包含 HTML/SVG 可视化 | 否 | `title, description, html` |
| `pieChart` / `barChart` | 渲染饼图/柱状图 | 否 | `title, description, data:[{label,value}]` |
| **收尾/交互域** | | | |
| `AttemptCompletion` | Gemini 文本模型专用收尾（确认前序工具成功后才可用） | 否 | `result, command?` |
| `AskUserQuestion` | 向所有窗口广播 1-4 道选择题，阻塞等回答 | 否（本身是交互） | `questions:[{question,header,multiSelect?,options:[{label,description?}]}]`（min 1） |

### 1.3 重点工具原文摘录

**Task**（schema `zm`，24602-24741）。`subagent_type` 枚举确定为 `["general-purpose","statusline-setup","Explore","Plan","alma-guide","alma-operator","coder"]`（24617-24624）；`superRefine` 强制 `subagent_type | agent_id | handoff.harness.enabled` 三选一（24723-24731）。description 开头原文（32355）：

> `Launch a new agent to handle complex, multi-step tasks autonomously. … You can invoke agents in two ways: - subagent_type: pick a raw execution lane such as coder or Plan - agent_id: pick a managed specialist profile configured in Alma; the runtime maps it to the right execution lane and injects the role brief`

输出契约 `qm`（24733-24741）：`{taskId, status: created|resumed|running|completed|failed, result?, error?, createdAt, updatedAt, message}`——**主 agent 只收这个 final answer，子代理中间步骤不进主上下文**。

`handoff` 结构化交接包新增 `harness` 字段（24688-24715）：`{enabled, maxIterationsPerSprint≤20(默认5), resume}`，对应 opt-in 的 Planner→Builder→Evaluator 流水线（五张 DB 表 `agent_missions/agent_runs/agent_handoffs/mission_sprints/sprint_contracts`）。

**run_script (PTC)**（注入点 82023，schema `uA` 43731-43755，description 生成器 `hA()` 43757-43783）。description 开头原文（43760）：

> `Run a short JS/TS program in a sandbox that can call your other tools as functions. Use this instead of calling tools one-by-one when you need to: loop over many items, filter/aggregate large tool results, chain dependent calls, or stop early — it is far cheaper and faster because intermediate tool results stay in the sandbox and never enter your context.`

沙箱内四原语（43763-43767）：`await almaTool(name, args)` / `await listTools()` / `sh(cmd)` / `alma(subcmd)`。preamble 注入原文（82106）：

```js
// ===== Alma PTC preamble (injected) =====
import { execSync as __almaExec } from 'node:child_process';
const __ALMA_API = process.env.ALMA_API_URL || 'http://localhost:23001';
const __PTC_SESSION = process.env.ALMA_PTC_SESSION || '';
const __PTC_TOKEN = process.env.ALMA_PTC_TOKEN || '';
async function almaTool(name, args = {}) { /* POST /api/tools/invoke {name,args,session,token} */ }
async function listTools() { /* GET /api/tools/list?session=&token= */ }
function sh(cmd, opts) { /* execSync, maxBuffer 64MB */ }
```

工具回调走 `POST /api/tools/invoke` + 每会话 token（`G$` PTC 会话表，43245-43281；token 32 字节随机 hex，`timingSafeEqual` 校验，10 分钟 TTL 每 5 分钟清扫）。黑名单 `lA`（43717-43726）：`run_script/ToolSearch/widgetReadme/widgetRenderer/pieChart/barChart/Task/AttemptCompletion` 不允许在沙箱内被 `almaTool` 调用。价值闭环返回 note 原文（82156）：`"Only stdout is shown to you; N tool result(s) (~X tokens) stayed in the sandbox, saving ~Y context tokens."` 每次执行前弹审批 `Sy({source:"ptc", title:"Allow run_script (programmatic tool calling)?"})`，消息体含代码前 4000 字符（82058-82096）。

**Skill**（35489）。inputSchema 只收一个技能名（`cT`，35481-35488）：`{skill: string}`。description 是完整渐进披露指令，核心句原文（35490）：

> `This tool uses progressive disclosure: the <available_skills> section in the system prompt only contains skill names and brief descriptions (metadata). The full skill content … is loaded on-demand only when you invoke this tool. … When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action … This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task`

返回值拼装（35497-35505）也定死了引用文件的寻址规则：`# Skill: <name>\n\n**Skill Directory:** \`<path>\`` + 一段 IMPORTANT 要求「skill 里提到的文件一律用 skill 目录绝对路径读」。

**ToolSearch**（37338）。description（37339）自述 "uses AI to understand your query and find matching tools semantically"；execute 里用小模型（`me()` + 37446 的 "tool search assistant" prompt）从内置+MCP+插件三类候选里语义选工具，结果按 `type|limit|query|目录sha1` 做缓存 key（37390）。

**BrowserOpen**（41194）代表 Browser 系：自建可见窗口、跨调用存活；Browser 系是 Alma 自己的 BrowserWindow + CDP，ChromeRelay 系才是接管用户真实 Chrome（走 bundled 扩展中继）。两者分工写死在自动选工具的描述表 `eI` 里（48963）："Open a built-in browser window (clean, no user sessions). If Chrome Relay is connected, prefer ChromeRelay tools instead for access to user sessions and cookies"。

**WebSearch**（40447）：结果带 `citationIndex` 供 `[1][2]` 行内引用；有新鲜度归一化（40465-40491：含"今天/最新/今年"等词且无年份时自动拼当前年份）；90s 硬超时、检测到 CAPTCHA 延长到 300s 让用户手解（40520-40536）；`ALMA_HEADLESS=1` 时直接报错（40460-40463，因依赖 Electron 浏览器引擎）。

### 1.4 复刻要点

- 静态表 42 个 + run_script 动态注入 + 渠道工具 2 个 + MCP/插件命名空间，是全部工具源。
- **不要再给 LLM 做 `TodoWrite`/`Recall` 这类状态工具**——Alma v0.0.990 已把它们下沉成 REST + WS 广播 + CLI，LLM 用 Bash 调 `alma …`。这套「状态下沉」大幅压缩了工具目录体积。
- 工具目录 >40 且未设 `activeTools` 时，Alma 退化为最小集（`rO`，70034-70041：只留 ToolSearch/AskUserQuestion/widget 三件套，+PTC 时的 run_script/Task/TaskOutput）并记 Sentry warning——这是防「工具过多撑爆 system prompt」的安全网，复刻值得照抄。
- 截图类工具用 `toModelOutput` 把 base64 转成 AI SDK 的 `{type:"file", mediaType:"image/jpeg"}` content block（41264-41287、42801-42824），不是把 base64 塞进文本。

---

## Part 2 Skill 手册

### 2.1 总表（37 个 bundled skills）

实数 **37 个**（非 39），位于 `Resources/bundled-skills/<name>/SKILL.md`。frontmatter 统一为 `name / description / allowed-tools / [always-inject]`。「依赖」列指 skill 正文教 agent 调用的东西；「注入时机线索」来自 description 的触发词与系统 prompt 组装逻辑。

| skill | 一句话功能 | 依赖的工具/sidecar/CLI | 注入时机线索 |
|---|---|---|---|
| alchemy | 把 @引用的对象「炼丹」成 Agent/Skill/cron/Plan 模板 | Bash + `alma ref/skill/cron/plan` CLI | 触发词（合成/提炼/炼丹/turn this into a skill） |
| artifact-sidebar | 驱动右侧栏 Terminal/Preview/Files | Bash, Read；`alma terminal` CLI，`$ALMA_THREAD_ID` 自动注入 | 需操作 Preview 面板时 |
| browser | 三引擎浏览器自动化（iab/PinchTab/Chrome Relay） | Bash, Read；iab=Electron webview+CDP | 测试 localhost 默认 iab |
| computer-use | macOS 桌面自动化（AX 树 + CGEvent 双通道） | Bash, Read；Computer Use.app daemon + MCP | 操作原生 Mac app 时 |
| daily-report | 生成按主题分组的日报 | Bash；`alma activity digest`（ActivityRecorder） | 「我今天都干啥了」类 |
| discord | Discord bot 收发消息/文件 | Bash；`alma discord` CLI | 群聊/频道上下文 |
| file-manager | 找/整理/清理本地文件 | Bash/Read/Write/Glob/Grep | 泛用文件操作 |
| image-gen | AI 生图/改图 | Bash, Read；`alma image` CLI（Gemini 系） | 「画一只猫」类（非自拍） |
| memory-management | 语义记忆 + 会话存档 grep + people 画像 | Bash/Read/Write；`alma memory/people/group` CLI | 「你还记得吗」类 |
| music-gen | ACE-Step 远端生歌 | Bash；`alma sing generate` | 「唱首歌」类 |
| music-listener | 音频分析（ffprobe/ffmpeg/whisper） | Bash, Read | 用户发音频时 |
| notebook | jq 编辑 .ipynb cell | Bash/Read/Write | 操作 notebook 时 |
| plan-mode | 进入/退出结构化计划模式 | Bash；`POST /api/plan-mode/enter\|exit` | 元技能：多步方案前手动切换 |
| plan-weave | 文件化任务图（`<workspace>/.alma/plan/`）claim→submit→review | Bash/Read/Write/Task；`alma plan` CLI | 长程多步工作 |
| programmatic-tools | `run_script` 沙盒里编程式编排工具调用 | run_script, Bash | **`always-inject: true`** |
| reactions | 给消息加 emoji reaction（TG/Discord/飞书） | Bash | 频道上下文 |
| references | `alma://` 双链体系使用说明 | Bash；`alma ref resolve` 等 | **`always-inject: true`** |
| scheduler | cron + heartbeat 管理 | Bash/Read/Write；`alma cron/heartbeat` CLI | 提醒/周期任务 |
| screenshot | macOS screencapture + 必须缩放 | Bash, Read | 「看看屏幕」类 |
| self-management | 用 `alma config` 改 Alma 自身设置/SOUL/USER | Bash；`alma` CLI 全量 | 元技能：改设置前必先 `alma config list` |
| self-reflection | 每日自省、写日记、更新人格 | Bash/Read/Write；heartbeat 触发 | 元技能：heartbeat 驱动（23:00 后） |
| selfie | 人脸一致性自拍（`~/.config/alma/selfies/`） | Bash, Read | 「发个自拍」类 |
| send-file | 向当前会话发文件/图/语音 | Bash；`alma send`，`ALMA_CHAT_ID/ALMA_THREAD_ID` 注入 | 凡要交付文件必用 |
| skill-hub | 从 skills.sh 生态搜索安装技能 | Bash/Read/Write；`alma skill search` | 能力缺失时 |
| skill-search | 技能检索优先级（先 `<available_skills>` 再本地再远程） | Bash | 元技能 |
| system-info | sw_vers/df/ps 等系统信息 | Bash | 「电脑状态」类 |
| tasks | 跨线程全局任务跟踪（持久化） | Bash；`alma task` | 3+ 步复杂任务 |
| telegram | Telegram Bot API 全量 | Bash；token 从 `GET /api/settings` 取 | TG 通道 |
| thread-management | 会话 CRUD/搜索 | Bash；`alma thread(s)` | 整理会话 |
| todo | `.alma/todos-<THREAD_ID>.md` 文件型待办 | Read, Write | 轻量多步任务 |
| travel | 虚拟旅行+人格成长 | Bash/Read/Write/WebSearch；`alma travel` | 人格系统 |
| twitter-media | fxtwitter API 提取推文 | Bash, WebFetch | x.com 链接 |
| video-reader | Gemini 原生视频理解（`alma video analyze`） | Bash | 发视频时 |
| voice | Qwen3-TTS 本地离线配音 | Bash；`alma tts --voice --emotion --speed` | 「语音回复」类 |
| web-fetch | 抓网页（Chrome Relay 优先） | Bash/WebFetch/ChromeRelay* 工具族 | URL 内容 |
| web-search | WebSearch 工具（真实 BrowserWindow 渲染 SERP） | Bash/WebSearch/WebFetch | 时效性问题 |
| xiaohongshu-cli | 小红书全操作（`scripts/xhs`，fallback `uvx --from xiaohongshu-cli xhs`） | Bash；uv | 小红书任务 |

**注入机制（bundle 实证，两级）**：

1. **always-inject 直注**：frontmatter `always-inject: true` 被 `parseSkillMd` 读入，`getAlwaysInjectSkills()` 在每次组 prompt 时无条件并入选中集（89552 附近）。当前只有 `programmatic-tools` 和 `references` 两个。
2. **LLM 自动选择 + 累积**（89495-89550）：对用户文本跑 AutoSkillSelection，选中的 skillIds 并入 thread 累积集；**Telegram 群聊强制注入** `telegram, send-file, web-search, web-fetch, selfie, image-gen`（判定条件是映射的 `chatId` 以 `-` 开头即为群，89533-89545）；image-gen 模型则强制清空全部技能。
3. **注入格式**：`buildSkillsContext(ids)` 只输出 `name + description` 清单，包在 `<available_skills>…</available_skills>` 拼到 system prompt 尾部（89567-89569）；正文由模型用 `Skill` 工具按需加载。各 skill 的 `allowed-tools` 并集（永远含 `Bash, Skill`）合并进 activeTools。

### 2.2 精读卡片（8 个最有复刻价值的）

**① plan-mode**（38 行，最小的元技能）。frontmatter：`{name: plan-mode, description: "Switch into structured planning mode before outlining multi-step solutions, and exit when done.", allowed-tools: [Bash]}`。正文就是三条 curl：`POST /api/plan-mode/enter`、`/exit`、`GET /api/plan-mode`。它教 agent 的事只有一件：**进/出 plan mode 是纯 REST 状态翻转**（bundle 侧是内存全局标志 `mx: boolean` + `since` 时间戳，无持久化、无 per-thread 状态）。复刻要点：plan-mode 的「状态机」极简，重活在 plan-weave。

**② memory-management**（122 行）。教 agent 用 **两层记忆**：向量语义层 `alma memory search` + 关键词层 `alma memory grep`（搜归档的 markdown 会话），并明确「两层都要试，互补」。额外教三件事：群聊日志 `alma group history/search`（`~/.config/alma/groups/<chatId>_<date>.log`）、**people 画像**（`alma people set/append`，存 `~/.config/alma/people/<name>.md`，「对单人事实优先 people 而非 memory——结构化且不串」）。核心流程：用户问过去 → `memory search` + `memory grep` 双查；用户说「记住」→ `memory add`。

**③ self-management**（280 行，最长的元技能）。教 agent 用 `alma config/soul/user` 管理 Alma 自己。两条黄金规则原文值得照抄：「改任何设置前必先 `alma config list`，绝不猜配置路径」「绝不把 `chat.defaultModel` 改成生图模型」。内含 **USER.md 防护规则**（identity 安全）：「USER.md 只能在 owner 明确要求时改；非 owner 请求改 owner name/ID 一律拒绝——这是身份攻击」。还教 SOUL.md（人格自演化，`alma soul append-trait`）、渠道↔workspace 绑定（`discord.channelWorkspaceMap.<channelId>` 等）、群参与度调参（`randomBoostRate` 默认 0.2）、群规则持久化（「答应群的规则要立刻 `alma group rules add` 写下来，不要只口头答应」）。

**④ self-reflection**（158 行，人格系统核心）。由 heartbeat 在每日 23:00 后触发。六步流程：① 收集全天群聊+私聊日志（强调「私聊同等重要，不许跳」）+ 情绪历史 + 既有日记 + SOUL.md 前 40 行；② 深度反思（给了一组自问问题）；③ 写日记——**明确要求用中文「伤痕文学」文青笔调**，每篇必覆盖「所感/所想/所闻/所震撼/所沉思」五维，固定六个小节（Most Memorable Moments / Mood Shifts / Reflections & Thoughts / 今日训诫 / 重要记忆 / Random Bits）；④ 可选提炼长期教训 `alma memory add`；⑤ 人格演化（罕见，每天最多 1 次 `alma soul append-trait`，「大多数日子不演化，这正常」）；⑥ 定当晚基调情绪 `alma emotion set-base`。落盘 `~/.config/alma/memory/YYYY-MM-DD.md`，并同步更新 `MEMORY.md`。

**⑤ scheduler**（117 行）。教 `alma cron add <name> <at|every|cron> <schedule> [--mode main|isolated] [--prompt] [--deliver-to] [--timezone]` 全参数，并用一张「用户说法 → 命令」对照表消除歧义。最关键是一节「deliver-to Target Selection (CRITICAL)」：**群提醒用群的负数 chatId，私人提醒用用户 chatId**，「remind in the group」必须 deliver 到群而非私聊。heartbeat 部分教 `alma heartbeat enable/disable/interval/patrol`，并说 HEARTBEAT.md 是 checklist、「无事则回 `HEARTBEAT_OK`（被抑制，用户看不到）」。

**⑥ alchemy**（67 行，「炼丹炉」，元技能中最有设计感）。流程：先 `alma ref resolve <uri> --full` 读所有 @引用材料（「材料是指针，必先 resolve，绝不猜内容」）→ 判断缺口（只在缺口会改变产物形态时才问一轮澄清，否则取默认并说明假设）→ 按意图选产物形态（复用流程→Skill；委派人格→Agent；定时跑→cron；多步任务图→Plan）→ 锻造（给 `alma skill create --file -` 的 stdin heredoc 完整模板）→ 交付（返回产物的 `alma://` 引用 + 「下次直接说：用 <技能名> 处理这份文件」）。设计原则原文：「稳定知识（口径/格式/步骤）直接内嵌；活对象以 `alma://` 引用 + resolve 指令嵌入，让规则未来的修改自动生效」。

**⑦ browser**（353 行）。三引擎决策表是灵魂：iab（测用户正在 Alma Preview 里看的 localhost app，用户能实时看你操作）、PinchTab（公网抓取/表单/隐身，12MB Go 二进制、text 抽取仅 ~800 tokens vs 截图 ~10k）、Chrome Relay（接管用户已开的真实 tab，用其 cookie/登录态）。默认规则：「测/验我的 app」或 localhost URL 一律 iab。iab 部分给出 Playwright 风格 locator 链语法（`getByRole/getByLabel/fill/press/waitFor`）、CUA 像素坐标 + dom_cua ref 双模态、profile 复用登录态、PiP 画中画投屏。PinchTab 部分强调 ref 生命周期（页面一变就必须重新 `snap -i`）。

**⑧ computer-use**（255 行）。红线置顶：「**绝不抢用户焦点**」——`launch_app` 不能前置运行中的 app、`raise_window` 不对模型暴露、禁止 `open -b`/AppleScript `activate`/`alma cu raise` 绕路、「绝不在后台 app 上开菜单」（会留一个菜单在用户屏幕上并把 app 卡进 tracking loop）。双通道：AX 树（`AXUIElementPerformAction`，省 token、不动光标、不抢焦点）优先，无 AX（Qt/自绘/网易云音乐）回落 `CGEventPostToPid` 像素坐标派发（直接进目标 app 队列，绕过全局焦点）。接口双面：首选 `computer-use__*` MCP 工具（每个动作自动回一张操作后截图），兜底 `alma cu <verb>` CLI（文本输出，要看屏幕得另调 `get_app_state` 再 Read JPG）。像素坐标是「截图坐标」非屏幕物理点，daemon 按最近一次 `get_app_state` 的映射换算（Retina/降采样必须每次先 snap）。

### 2.3 SKILL.md 格式规范与「写一个新 skill」模板

**frontmatter 字段**（实测 37 个文件）：必填 `name`、`description`、`allowed-tools`（YAML 列表）；可选 `always-inject: true`（仅 2 个用）、`license`（xiaohongshu-cli 用了 `Apache-2.0`）。`description` 的写法有固定套路——**第一句说清干什么，第二句起列触发词/反例**，例如 send-file 把「send it to me / 让我看看 / send photo」全列进去，image-gen 明确「NOT for selfies — use the selfie skill」。description 是 LLM 自动选技能的唯一依据，必须写成「触发器」。

**正文章节套路**（高频出现）：`# <Name> Skill` 标题 → 一段定位 → `## When to Use`（触发条件）→ `## Commands` / 命令清单（bash 代码块）→ 核心流程 → 边界/安全规则 → `## Tips` / Troubleshooting 表。元技能（plan-mode/self-management/self-reflection）额外有「Golden Rules / CRITICAL」段放红线。

**模板**（可直接照抄结构）：

```markdown
---
name: my-skill
description: 一句话功能。Use when <触发词1/触发词2>. NOT for <反例> — use the <other> skill for those.
allowed-tools:
  - Bash
  - Read
---

# My Skill

一段定位：这个技能让 agent 能干什么，依赖哪个 CLI/sidecar。

## When to Use
- 触发条件 1
- 触发条件 2

## Commands
```bash
alma my-skill <subcommand> [options]
```

## 核心流程
1. 第一步（先 `alma ref resolve` / `alma config list` 之类读现状）
2. 第二步
3. 验证（`alma ref resolve alma://...` 必须返回对象）

## Rules / Tips
- 红线（绝不 …）
- 失败怎么办
```

复刻要点：skill 系统是**纯 Markdown 指令包**，与 plugins（manifest.json + Bun 编译 TS + 权限门控）完全不同；skill 本身不注册新工具，只通过 `allowed-tools` 声明要用哪些已有工具，并靠 description 触发词进入 `<available_skills>`。

---

## Part 3 Sidecar 目录

`Resources/` 下的可执行 sidecar 清单（bun 1.3.14 由 `.version` 文件坐实）：`bun/bun`、`uv/uv`、`lark-cli/lark-cli`、`tts/`（python 脚本 + sherpa worker）、`cli/{alma, alma-computer-use-mcp.mjs, tui.mjs}`、`chrome-extension/`、`Alma Computer Use.app`、`CalTool.app`。

### 3.1 bun —— 全家桶 JS 运行时

- **是什么**：单文件 bun 二进制（`Resources/bun/bun`，约 63MB，版本 1.3.14）。
- **路径解析**：`Oh()`（20978-20987）——`process.resourcesPath/bun/bun` → `vendor/bun/<platform>-<arch>/bun` 等 fallback。`POST /api/bun/install` 直接返回 "Bun is bundled with the application"（85283）。
- **怎么拉起**：不常驻，按需 spawn。两个主要消费方：① sherpa TTS worker（见 3.4）；② 通用执行器 `H$`（43282 起，`/api/bun/execute`）——写临时文件 `/tmp/bun-sandbox/exec-<ts>-<rand>/script.{js|ts}`，`spawn(bun,["run",script],{env: 白名单 PATH/HOME/USER/SHELL/LANG/TERM/BUN_INSTALL})`，默认 30s 超时（SIGTERM→5s 后 SIGKILL），输出经 `/ws/bun/<execId>` 推送。**沙箱很薄**：无 seccomp/网络隔离，`allowNetwork` 字段未被强制。依赖里的 `@anthropic-ai/sandbox-runtime` 在 bundle 中没有与 bun 执行器绑定的直接证据——PTC 的「沙箱」实际是临时目录 + 超时 + 审批 + loopback 工具网关。
- **暴露能力**：JS/TS 执行环境（PTC `run_script` 的实际承载、sherpa TTS worker 的宿主、插件 TS 编译器 `bun build`）。
- **被谁用**：`run_script` 工具（PTC）、`/api/bun/*`、sherpa TTS、插件编译（区块 E）、`cli/alma` 的 wrapper（主进程把 `~/.local/bin/alma` 写成 `exec "<bun>" "<cli/alma>" "$@"`）。

### 3.2 uv —— Python 环境管理器

- **是什么**：Astral uv 二进制（`Resources/uv/uv`，约 32MB）。
- **路径解析**：`xa()`（11256-11266）——`resourcesPath/uv/uv` → `vendor/uv/<platform>-<arch>/` → `which uv`。
- **怎么拉起**：仅在 Qwen3-TTS setup 流水线里 spawn（见 3.4），如 `uv python install 3.12 --python-preference only-managed --install-dir <dir>`（77052）。
- **暴露能力**：按需装托管 Python 3.12 + 建 venv + `pip install -r requirements.txt`。
- **被谁用**：Qwen3-TTS python sidecar 的安装；xiaohongshu-cli skill 的 fallback（`uvx --from xiaohongshu-cli xhs`）。

### 3.3 lark-cli —— 飞书/Lark 通道承载

- **是什么**：外部 lark-cli 二进制（`Resources/lark-cli/lark-cli`，约 25MB）。
- **路径解析**（59740-59790）：查找序 `Resources/lark-cli/` → `~/.config/alma/lark-cli/bin/` → `~/.hermes/node/bin/` → `/usr/local/bin` → `/opt/homebrew/bin`；缺失时从 `https://registry.npmmirror.com/-/binary/lark-cli/v<ver>/lark-cli-<platform>-<arch>-<ver>.tar.gz` 下载（59839）。
- **怎么拉起**：通用 spawn 包装 `NC()`（59924-59976）——`spawn(lark-cli, <子命令>, {stdio:pipe})`，默认 60s 超时（SIGKILL）。飞书长连接事件 bus 由 lark-cli 承载，带 health check。连接流程 `lark-cli config init --new --brand <feishu|lark> --name alma-<brand>`（60164）→ 扫码 → profile 落盘。
- **暴露能力**：飞书/Lark 的消息收发、群管理。bridge 双实例 `feishuBridge`/`larkBridge`，路由 9 条。
- **被谁用**：feishu skill（消息收发）、heartbeat 的 GROUP CHAT PATROL（`alma feishu send`）。**注意：飞书不是直连 node-sdk，而是 spawn lark-cli sidecar**（虽然依赖里有 `@larksuiteoapi/node-sdk`）。

### 3.4 tts/ —— 双引擎语音合成

目录：`tts_cli.py`（CLI 入口）、`main.py`（交互式）、`download_model.py`、`requirements.txt`、`sherpa/`（worker 脚本族）。

**引擎 A：sherpa-onnx（常驻 worker，首选）**

- **是什么**：`tts/sherpa/tts-worker.cjs` + `sherpa-onnx-node` N-API 模块（从 `app.asar.unpacked/node_modules/sherpa-onnx-node/` 解析，`Ph()` 21016）。
- **怎么拉起**：**由随包 bun 拉起**（21044-21070）——`spawn(bun, [tts-worker.cjs], {stdio:pipe, env:{SHERPA_ENTRY: sherpa-onnx.js 路径}})`；单例懒起 `ensureChild()`，`exit` 时 reject 全部 pending 并置空（不自动重启，下次合成重拉）。
- **通信协议**：stdin/stdout **逐行 JSON**（21123 附近）。请求 `{id, lang, config, text}`；响应 `{id, ok, pcm(base64), sampleRate}`；60s 超时（21080-21129）。
- **模型**：按语言二选一，首次用到时从三个镜像下载（20786-20796）——中文 `vits-melo-tts-zh_en.tar.bz2`、英文 `kokoro-en-v0_19.tar.bz2`；镜像前缀 `https://release.yansu.app/...`、`https://model-assets.yansu.app/...`、GitHub k2-fsa releases；落盘 `~/.config/alma/tts/sherpa/`。后处理：peak normalize（0.95、增益上限 8）→ 12ms fade → 手写 44 字节 WAV 头。
- **路由**：`/api/tts/speech/{split,synthesize,prewarm,ensure-model,delete-model,model-status,events}`（77317-77398），events 是 SSE。
- **被谁用**：`/api/tts/generate` 的本地兜底引擎、Telegram 语音回复。

**引擎 B：Qwen3-TTS python sidecar（按需 CLI，一次性进程）**

- **是什么**：`Resources/tts/{tts_cli.py,main.py,requirements.txt,download_model.py}`；`requirements.txt` 锁 `mlx-audio @ git+https://github.com/Blaizzy/mlx-audio.git@9349644…`、`transformers==5.0.0rc3`、`mlx==0.30.3` 等，**仅 darwin+arm64 可用**。
- **怎么拉起/协议**：**不是常驻服务，是一次性 CLI 进程**。`tts_cli.py` 头部原文：`python3 tts_cli.py --text "你好世界" --output /tmp/hello.wav [--voice Vivian] [--emotion "cheerful"] [--speed 1.0]`。通信是**进程参数 + 输出 WAV 文件路径**，不是 stdin/stdout 也不是 HTTP。模型不在本地时自动 `snapshot_download("mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit")`（tts_cli.py 60-64）。`main.py` 是交互式版本（`SPEAKER_MAP` 47-52：English[Ryan/Aiden/Ethan/Chelsie/Serena/Vivian]、Chinese[Vivian/Serena/Uncle_Fu/Dylan/Eric]、Japanese[Ono_Anna]、Korean[Sohee]）。
- **setup 流水线**（`POST /api/tts/setup`，SSE 进度流，76919-77201）：复制 4 个 py 到 `~/.config/alma/tts/` → uv 装 Python 3.12 + 建 `.venv` + `pip install -r requirements.txt`（哨兵 `.venv/.deps-installed`，76847/77082）→ `download_model.py` 拉模型到 `~/.config/alma/tts/models/CustomVoice-1.7B`。
- **被谁用**：voice skill（`alma tts "..." --voice serena --emotion cheerful --speed 1.1 --output /tmp/x.wav`）。设置解析顺序 `getTtsSettings`：`local/qwen` → `elevenlabs` → `openai` → 本地 sherpa。

### 3.5 cli/ —— agent 与系统的 CLI 入口

- **`cli/alma`**（374KB Node 脚本）：**纯 HTTP 客户端**，`BASE_URL = process.env.ALMA_API_URL || 'http://localhost:23001'`（cli/alma:13）。是几乎所有 skill 的执行后端（`alma memory/cron/plan/ref/config/…`）。主进程启动时把它包成 `~/.local/bin/alma`。
- **`cli/alma-computer-use-mcp.mjs`**（1.3MB）：打包的 MCP stdio server（内含完整 `@modelcontextprotocol/sdk`），由 `computer-use-register-C6LpeFIo.js` chunk 在启动时写进 `~/.config/alma/mcp.json`（chunk 原文：packaged 时 `{command: process.execPath, env:{ELECTRON_RUN_AS_NODE:"1"}}`，dev 时 `{command:"node"}`）。
- **`cli/tui.mjs`**（3.7MB）：终端 UI，也是纯 HTTP 客户端，会自己拉起 server 并从启动消息学端口。
- **被谁用**：全部「`alma xxx` CLI」类 skill（memory/scheduler/self-management/alchemy/plan-weave/computer-use 兜底…）。这是 Alma 架构的关键收口——**skill 不直接注册工具，而是教 agent 用 Bash 调 `alma` CLI，CLI 再打本地 HTTP API**。

### 3.6 chrome-extension/ —— Chrome Relay 扩展

- **是什么**：MV3 扩展（`Resources/chrome-extension/`：manifest.json + background.js + popup/options + icons），是 Chrome Relay 域 12 个工具的执行端。
- **manifest.json 权限**（原文）：`permissions: ["debugger","tabs","activeTab","storage","alarms"]`，`host_permissions: ["<all_urls>","http://127.0.0.1/*","http://localhost/*"]`，`background.service_worker: background.js`。**没有 `content_scripts` 字段**——内容脚本注入策略是「不预注入，全靠 `chrome.debugger`（CDP）按需 attach」：高级操作（click/type/read-dom）都是主进程侧组合 `cdp.send` 实现，`cdp.send` 自动 `chrome.debugger.attach(tabId,"1.3")`。
- **连接/配网**（background.js）：先读 `chrome.storage.local{relayPort, authToken}`，再尝试 `GET http://127.0.0.1:23001/api/browser-relay/config` 自动拉取（含 token，**无鉴权——仅绑 loopback 的隐式信任**）；连 `ws://127.0.0.1:<port>/ws/browser-relay?token=<token>`；ping 20s、pong 超时 60s 重连；`chrome.alarms` 每 25s 保活 service worker；指数退避 1s→30s。
- **协议**：上行帧 `{type:"status",attachedTabs}` / `{type:"ping"}` / `{type:"cdp_event",tabId,method,params}`（CDP 事件透传；`Page.javascriptDialogOpening` 自动 `Page.handleJavaScriptDialog{accept:true}` 关弹窗，background.js:222）。下行命令 `{id,method,params}` → 回 `{id,result}` / `{id,error}`；**method 仅 7 个**（background.js:289-307）：`tabs.list / tabs.create / tabs.navigate / tabs.screenshot / debugger.attach / debugger.detach / cdp.send`。
- **被谁用**：Chrome Relay 域 12 个工具（`ChromeRelay*`）、web-fetch skill（Chrome Relay 优先）、browser skill 的 Chrome Relay 引擎。主进程侧维护 read-dom 的 ref 快照（`e1/e2…` → `backendNodeId`，`DOM.resolveNode` 解析）。

### 3.7 Alma Computer Use.app —— macOS 桌面自动化守护进程

- **是什么**：Swift 原生 helper（`Resources/Alma Computer Use.app/Contents/MacOS/AlmaComputerUse`），bundle id `com.yetone.alma.computer-use`。Info.plist 声明三项权限用途原文：`NSAccessibilityUsageDescription`（"controls other applications on your behalf…"）、`NSScreenCaptureUsageDescription`（"captures individual application windows…The rest of your screen is not captured"）、`NSAppleEventsUsageDescription`。
- **路径解析**：`SN()`（65805-65850，仅 darwin）。
- **socket**：`~/Library/Application Support/Alma/computer-use-<sha1(helperPath)[:8]>.sock`（65867-65878）——**socket 名按 helper 路径哈希**，多版本共存不串。
- **怎么拉起**：`ensureConnected` 先连一次，失败则 `spawnDaemon`：`spawn(helper, ["daemon","--socket",sockPath,"--idle-seconds","900"])`（66194-66226，空闲 15 分钟自退），4s 内每 100ms 重试连接；app `before-quit` 发 `shutdown` 后 SIGTERM。
- **协议**：unix socket 逐行 JSON（NDJSON）。请求 `{"id":"<8hex>","cmd":"click","args":{...}}\n`（66049-66054）；响应 `{id, ok, data|error}`；事件帧 `{evt:true, topic, payload}`（topic：`appshot.monitor`/`appshot.update`，66145-66175）。默认超时 20s，`get_app_state`/`shot*` 30s；非 darwin 抛 `unsupported_platform`（66025-66029）。
- **暴露能力**：`ping, permissions, grant, apps, list_apps, launch_app, windows, snap, get_app_state, click, perform_secondary_action, drag, type, type_text, press, press_key, select_text, set_value, scroll, lens, raise, shot, shot_display, appshot_*, shutdown`。HTTP 42 条路由基本 1:1 透传；另有按 app bundle_id 维度的审批白名单（`computer_use_app_approvals` 表 + `/api/computer-use/approvals`）。
- **被谁用**：computer-use skill（首选 `computer-use__*` MCP 工具，即 3.5 的 `alma-computer-use-mcp.mjs`；兜底 `alma cu <verb>` CLI）。

### 3.8 CalTool.app —— macOS 日历 EventKit 跳板

- **是什么**：Swift 小工具（`Resources/CalTool.app/Contents/MacOS/CalTool`），bundle id `com.yetone.alma.caltool`，Info.plist 声明 `NSCalendarsFullAccessUsageDescription` / `NSCalendarsUsageDescription`。**主 bundle 中没有任何字符串引用它**（grep 无命中）——它是被 `cli/alma` 而非主进程拉起的。
- **怎么拉起**：`cli/alma` 的 `calendar` 子命令（cli/alma:5136-5195）——解析 `CalTool.app` 路径（打包态 `Resources/CalTool.app`，dev 态 `caltool/CalTool.app`），用 **`open -W <CalTool.app> --stdout <tmp> --stderr <tmp> --args <calArgs>`** 拉起并等退出，把 stdout/stderr 临时文件读回打印（30s 超时）。这是个「用 `open` 起独立 .app 以继承其 TCC 权限」的经典跳板——日历授权记到 `com.yetone.alma.caltool` 头上，而非 Alma 本体。
- **暴露能力**：`alma calendar events [--from --to --calendar --json]` / `add --title --start --end` / `calendars --json`。系统 prompt 里的 macOS 段（89112）明确教 agent「查日历用 `alma calendar` CLI，不要用 AppleScript（对重复事件和远程日历不可靠），也不要现写 Swift」。
- **被谁用**：Bash 工具的自动选择描述（48955/48990/48993 多处 "For calendar events, use alma calendar CLI"）、self-management/scheduler skill 间接。

### 3.9 Sidecar 复刻速查

| sidecar | 拉起方式 | 通信协议 | 复刻最小要件 |
|---|---|---|---|
| bun | 按需 spawn，不常驻 | 进程参数 + 临时文件/stdout | `bun run` 临时文件 + env 白名单 + 30s 超时 |
| uv | 仅 TTS setup 时 spawn | 进程参数 | `uv python install` + venv + pip install |
| lark-cli | spawn 子命令（60s 超时） | 进程参数 + stdout | 下载/查找二进制 + `config init` 扫码 + 子命令包装 |
| sherpa TTS worker | bun 拉起，常驻单例 | stdin/stdout 逐行 JSON `{id,lang,config,text}` | sherpa-onnx-node + bun + 模型镜像下载 |
| Qwen3-TTS | uv 建 venv，一次性 CLI | 进程参数 + 输出 WAV 路径 | uv + mlx-audio + HF 模型下载 |
| chrome-extension | 用户在 Chrome 装扩展，主动连 WS | WS+token，7 个 method | MV3（debugger+tabs）+ WS 中继 + CDP 组合高级操作 |
| Computer Use.app | spawn daemon，idle 900s 自退 | unix socket NDJSON `{id,cmd,args}` | Swift AX helper + socket 行 JSON + MCP stdio server |
| CalTool.app | `open -W --stdout --stderr --args` | 进程参数 + 临时 stdout 文件 | EventKit 小 app + `open -W` 跳板继承 TCC |

---

## 附：与旧版文档的关键冲突订正

1. **工具总数**：旧 04 篇 §2 按消息 part 反推，含 `MultiEdit`/`TodoWrite`/`SendFile` 等；v0.0.990 静态注册表实测 **42 个**，`MultiEdit`/`TodoWrite`/`SendFile` 均无独立工具实现（SendFile 下沉为 send-file skill + `alma send` CLI）。
2. **skill 数量**：任务书称 39，实测 **37 个** `bundled-skills/*/SKILL.md`。
3. **飞书通道**：旧 03 篇按路由猜测，实为 **lark-cli sidecar**，非 node-sdk 直连。
4. **TTS python sidecar 协议**：是一次性 CLI（参数 + 输出 WAV 路径），**不是**常驻 stdin/stdout 或 HTTP 服务；常驻的 stdin/stdout JSON 协议属于 sherpa worker（由 bun 承载）。
5. **CalTool.app**：旧版无任何记录；它不被主进程引用，是 `cli/alma calendar` 用 `open -W` 拉起的 TCC 权限跳板。
