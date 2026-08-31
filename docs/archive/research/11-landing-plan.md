# 11 · 落地计划：one-by-one 任务拆分

> **v2 修订（2026-08-21）**：本篇已被按 Alma v0.0.990 调研（16–21 篇）重排并补充 v2 增量任务（§3.5 S18–S24）。当前真实进度见 15 篇 §1 进度总览——S0/S1/S1.1/S2/S3/S5/S8 ✅、S4 主体 ⚙️、记忆/compact 超预期。**剩余关键路径：`S4收尾(S18) → S19 → S7 → S6 → S9 → S11`**（S8 已完成移出；S7 提前因为它欠债最少 + v2 规格最新鲜；S6 最重放后面）。§2–§5 是 v1 原始切片定义（仍有效，作每个 S 的「做什么/验收/文档」基准），进度状态以 15 篇 §1 为准。

> 本篇是整个系列的「施工总表」。把 06 篇的 M1–M6 体系和 09/10 篇末尾的 S0–S13 体系**统一到 S 体系**（06 的 M 体系以 Alma 记忆/人格为重心，与本地编码平台目标错位，不再使用，仅在 §0 保留对照）。
> 三个已定决策（影响全篇，先固化）：
> - **本地优先**：SQLite + Markdown 文件，服务端/Gateway 预留接口缝，不上服务端 DB。
> - **模型 provider：Anthropic (Claude)**：用 `@ai-sdk/anthropic`，与 WeaveLynx 同源（Claude 系）。`providers` 表首行填 Anthropic。
> - **目标平台：macOS only（arm64 单架构）**：省一半 02 篇的坑（TCC 隔离/签名/asarUnpack 简化），与 Alma 同。
>
> 原则：**任务粒度 = 可演示里程碑**，不是「建个组件」。每片结束在窗口里点一下能看到东西跑起来。理由：流式 agent 是 feedback-heavy 系统，晚了才发现流式顿挫要改底层管线——每一片都得当场验。

---

## 0. M 体系 vs S 体系对照（弃用 M，统一 S）

| 06 篇 M 体系 | 对应 S 体系 | 处置 |
|---|---|---|
| M1 会说话的壳 | = S1 | 内容一致，改名 |
| M2 落地存储 | = S2（+版本树） | S2 扩充版本树 |
| M3 工具调用 | = S4 | 一致 |
| M4 记忆与人格 | → S12（Phase E） | **推迟**：偏 coding 不需要早做 |
| M5 语义记忆+Skill | 拆为 S5（Skill）+ S12（语义记忆） | Skill 提前到 Phase B，记忆推迟 |
| M6 桌面化补完 | = S11 | 一致 |

06 篇缺的（S3 工作区 / S6 扩展宿主 / S7 子代理 / S8 MCP / S9 Git / S10 Gateway）是 WeaveLynx 视角补的，M 体系没有——这正是 06 偏记忆、欠平台的问题。**此后全系列只用 S 体系。**

---

## 1. 决策固化（开工前已定，勿再讨论）

| 决策 | 选定 | 影响的实现选择 | 依据 |
|---|---|---|---|
| 部署形态 | 本地优先 | SQLite+Markdown；loopback token 鉴权；不上服务端 DB | base 是 Alma、说「自己的 agent」 |
| **Agent SDK** | **Vercel AI SDK v5（`ai@^7` + `@ai-sdk/*`）** | 03/04/08 全套骨架直接照抄；subagent/skill 手搓（crew 注册表，04 §3.2）；多 provider 原生 | 见 §1.1 SDK 选型调研：Claude Agent SDK 官方不支持非 Claude 模型，与多模型硬需求冲突 |
| 模型 provider | Anthropic Claude（起步，可换） | `@ai-sdk/anthropic`；多模型槽 chat/toolModel 起步走 Claude 不同档 | 手头有 key；provider 与 SDK 是两个独立决策，换 provider 零成本 |
| 目标平台 | macOS only arm64 | asarUnpack 简化；TCC 隔离按 02 §6 做；electron-updater generic feed | 省 02 一半坑；与 Alma 同 |

### 1.1 SDK 选型调研结论（为什么不是 Claude Agent SDK）

曾考虑 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`，Anthropic 官方，原生 subagent/内置工具/session 恢复）。但调研发现它**官方明确不支持非 Claude 模型**：

- `model` 配置只接受 Claude 别名（sonnet/opus/haiku/fable）或 Claude 全名；官方 LLM gateway 页原话："doesn't support routing Claude Code to non-Claude models through any gateway"
- 即使用 gateway，Claude Code 硬过滤只保留 ID 含 "claude"/"anthropic" 的模型，主动忽略 gpt/gemini/deepseek/glm
- 社区 LiteLLM/OpenRouter 伪装 Anthropic API 是 work-around，非官方支持，且踩 Anthropic 专有字段（`thinking`/`context_management`）的坑

多模型是硬需求（要能跑其他 provider），与 Claude Agent SDK 的 Claude-only 硬约束直接冲突。故选 Vercel AI SDK——多 provider 一等公民，换 `@ai-sdk/*` 包即可，03/04/08 骨架直接照抄。

**subagent/skill 手搓的代价可接受**：Alma 就是这么做的（crew 注册表 04 §3.2），09 的 agentPlugin 设计本来就覆盖了能力槽注入。Claude Agent SDK 的原生 subagent 优势不足以抵消「锁死 Claude + 官方不支持多模型」的代价。若未来确认只跑 Claude，可再评估迁移。

### 1.2 多模型槽落地（04 §1.3 的 chat/toolModel）

起步走 Claude（手头有 key），架构上随时可换 provider：
- `chat` 槽 = `claude-sonnet-5`（主对话）
- `toolModel` 槽 = `claude-haiku-4-5`（子代理/工具循环/compact，省成本）
- 需要最深推理时手动切 `claude-opus-5`

换 provider 时：`providers` 表加一行 + 改 settings 的模型槽指向，`resolveModel`（04 §7）自动走新 provider——这是 Vercel AI SDK 多 provider 抽象的回报。

---

## 2. Phase A · 能用（2–3 周）

目标：一个能干活的 coding agent 雏形。

### S0 · 地基对齐（1–2 天）
**做**：electron-vite 三件套（main/preload/renderer）+ 内嵌 Express + loopback token + WAL + 目录骨架（10 §2）。
**验收**：
- [ ] `curl -H "x-myagent-token: <token>" http://127.0.0.1:23001/api/health` → `{ok:true}`
- [ ] 不带 token → 401
- [ ] 窗口加载 renderer，无白屏（show:false + ready-to-show）
- [ ] 目录符合 10 §2 三进程边界，renderer 无 `node:` import
- **文档**：02 §9.1–9.5 / 03 §9.5 / 10 §2
- **坑**：`listen` 必须绑 `127.0.0.1`（02 §9.5）；preload sandbox:true 单文件（02 §9.1）

### S1 · 会说话的壳（1 周）
**做**：AI SDK `streamText`（Anthropic）+ WS 直接转发 chunk + 前端 seq 重组 + rAF 字符泵 + Streamdown 分块 memo。历史先内存。
**验收**：
- [ ] 打字 → 流式出字，无顿挫（rAF 字符泵 EMA 跟踪到位）
- [ ] token 突发到达不卡（分块 memo 只重渲尾块）
- [ ] WS 断线重连后不丢不重（seq 重组验证：手动断 WS 再连，内容连续）
- [ ] 流式三红线文件就位：`shared/streaming/delta-accumulator.ts` / `use-smooth-stream.ts` / `shared/markdown/markdown.tsx`（10 §6）
- **文档**：01 §3.2 / 03 §3 / 04 §1.4 / 10 §6
- **红线**（01 §7，缺一不是 Alma 体验）：seq 乱序重组 / rAF 字符泵 / markdown 分块 memo

### S2 · 落地存储 + 版本树（2–3 天）
**做**：threads/messages（UIMessage 整存）+ parent/slot/depth 版本树 + providers 表（首行 Anthropic）+ settings。
**验收**：
- [ ] 重启后历史还在
- [ ] 重新生成同一提问 → 得到新版本，前端能切版本（switch-version）
- [ ] `sqlite3 chat_threads.db "SELECT message FROM chat_messages LIMIT 1"` 是完整 UIMessage JSON
- [ ] providers 表有 Anthropic 行，api_key 加密存储
- **文档**：03 §4.1 / §4.3 / §7.2 / §7.3
- **坑**：WAL 必开（03 §7.5）；message 整存 JSON 不拆子表（03 §7.5）

### S3 · 项目工作区（3–4 天）
**做**：workspaces 表 + 导入项目 + 工作目录 + CLAUDE.md/AGENTS.md 注入 prompt。新建 `features/workspace/`（10 §3）。
**验收**：
- [ ] 导入一个本地 repo 作为 workspace
- [ ] agent 的 cwd = workspace.path，文件工具在其目录干活
- [ ] workspace 有 CLAUDE.md 时，其内容注入 system prompt
- **文档**：03 §4.1 workspaces 表 / 10 §3 features 切分

### S4 · 工具 + Agent loop + 审批（3–4 天）
**做**：Read/Write/Edit/Bash + `stopWhen: stepCountIs(N)` + tool-overflow + 危险工具审批闸门。
> **v2 收尾见 §3.5 S18/S19**：审批中心升级（thread 作用域 policy key + bash 本地规则分级）归 S18，步中 AutoCompact + 工具数安全网归 S19。
**验收**：
- [ ] 说「在我工作区建 hello.txt 写首诗」→ 真建了
- [ ] Bash/Write/Edit 执行前弹审批，用户点允许才执行
- [ ] 超长 Bash 输出落盘 tool-overflow，消息里只有摘要+路径
- [ ] agent loop 多步工具调用可见（step-start part）
- **文档**：04 §2 / §2.3 / §5 / §7
- **坑**：tool-overflow 30 行必做（04 §2.3）；审批闸门是高阶函数包工具外层（04 §7 代码 5）

---

## 3. Phase B · 像 WeaveLynx（3–4 周）

目标：可扩展的多 agent 平台。

### S5 · Skill 机制（1 周）
**做**：SKILL.md 三级渐进披露 + Skill 工具。新建 `features/skills/`（10 §3）。
**验收**：
- [ ] 写一个「天气 skill」（SKILL.md 含 curl 模板），放在 skills/ 目录
- [ ] system prompt 的 `<available_skills>` 只含 name+description（不灌全文）
- [ ] 问天气 → agent 调 Skill 工具读全文 → 照 skill 做出来
- **文档**：04 §4 / §4.1 / §6.1
- **红线**：三级披露（metadata→全文→附属文件），否则几百 skill 爆 context（04 §4.1）

### S6 · 扩展宿主 + 槽位（1–2 周）
**做**：manifest/exposes.json + zod 校验 + EH（loader/registry/context）+ 4 槽位容器 + webview SDK bridge + agentPlugin 注入。新建 `slots/` + `features/extension-host/`（10 §5）。
> **v2 暖场见 §3.5 S24**：可先花 1 天做文件型 hooks（Alma hooks.json，约 200 行）当 S6 的能力槽低配前奏，降低 S6 空手启动的难度。
**验收**（09 §11 拆三子切片）：
- [ ] S6.1：hello-ext 的 appSidebar 槽位在侧栏渲染出组件；enable/disable 后出现/消失
- [ ] S6.2：hello-ext 的 greet skill 在 `<available_skills>`；问 hello → agent 调 `hello_greet` 工具
- [ ] S6.3：扩展前端 `host.invoke('greet')` 调到后端；命令面板出现 `Hello: 打招呼`；`host.ui.toast` 能弹
- **文档**：09 全篇
- **坑**：manifest 校验在执行扩展代码前（09 §10 坑1）；槽位上下文从 URL 来=不可信必校验（坑2）；activate 抛错不崩宿主（坑3）；懒激活（坑4）
- **关键接缝**：能力槽注入不改 04 runAgent，只改注入点数据来源（09 §6）

### S7 · 子代理 + fork-join（1 周）
**做**：Task/TaskOutput + run_in_background + resume + crew 注册表 + depth 限制 + 子代理关 parallelToolCalls。
> **v2 增强见 §3.5**：Alma 的子代理持久化三件套（任务落 DB + 重启自动 resume + resume prompt 模板原文）直接抄，规格在 20 §3；崩溃补跑机制（09 修订框）也在这片一并做。
**验收**：
- [ ] 主 agent 并行 fork 3 个后台调研子代理，立即拿到 taskId
- [ ] 逐个 TaskOutput(block:true) join，综合 3 份结论
- [ ] 子代理用 toolModel（Haiku，便宜），主 agent 用 chat（Sonnet）
- [ ] 子代理过程经 `/api/threads/:id/subagent-messages` 可见
- [ ] depth 超限拒绝委派；后台子代理异常不吞（join 方见到 failed）
- **文档**：04 §3 / 08 §3 / §7
- **坑**（08 §7 五坑）：后台异常被吞 / join 无超时 / 并行写同文件 / 无深度限制 / 子代理开并行 tool
- **复用**：子代理消息视图复用 `shared/streaming/`（10 §6，这是红线提升到 shared 的回报）

### S8 · MCP 接入（3–4 天）
**做**：mcp.json + `mcp__<server>__<tool>` 动态注册 + OAuth token 表。
**验收**：
- [ ] 配一个 MCP server（如 filesystem）
- [ ] agent 调用其工具，前缀 `mcp__filesystem__read`
- [ ] S6 的 mcp 能力槽接入此处（扩展声明的 mcp 并入 loadMcpTools 来源，09 §6）
- **文档**：04 §4

---

## 3.5 Phase B′ · v2 增量任务（S18–S24，承接 16 篇取舍）

> 这批任务来自 Alma v0.0.990 调研（16–21 篇）的「值得抄」清单（16 §3.1）。它们不是新阶段，而是穿插进关键路径的增量补丁。**每个任务的「参考文档」都标到 v2 篇目的具体小节**——动手前先读那一节，规格都在那里。
> 排序即建议施工顺序：`S18 → S19 → S7 → S24 → S6 → S9`。S20–S23 是低耦合小件，可穿插。

### S18 · 审批中心升级（S4 收尾，0.5–1 天）✅ 已完成（r7 T27–T31）
**做**：把现有 approval-gateway 补齐到 Alma `Sy()` 形态的三个可抄点（不抄 120s 超时——14 §4.4 已定「永远等人」）：
1. `allow_always` 改 **thread 作用域 policy key**：`bash:thread:<id>:command:<完整命令>` / `:all`、`mcp:thread:<id>:tool:<name>`。
2. Bash 命令**本地规则快速分级**：安全命令枚举（ls/cat/grep…直放）vs 需批命令枚举（rm/curl|sh…必批），只抄 Alma 指令的本地规则前半段，小模型二审推迟。
3. `approvalDecision={action, reason, decidedAt}` 回写消息 part 随流同步到前端。
**验收**：
- [ ] 同 thread 内「始终允许」某 bash 命令后，再次触发同命令不再弹审批；换 thread 仍弹
- [ ] `ls -la` 类安全命令直放不弹；`rm -rf` / `curl x | sh` 必弹
- [ ] 审批决策（含 reason）出现在消息 part 上，刷新后仍在
**文档**：**22 篇（S18 技术方案，含现状盘点 + r7 施工拆分 T27–T30）** / 16 §3.1-3（取舍与边界）/ 04 修订框（Alma `Sy()` 七级放行链 + policy key 模板）/ 14 §4.4（不抄超时的理由）/ **施工卡：`docs/plans/r7/`（T27–T30）**

### S19 · AutoCompact 步中压缩 + 工具数安全网（1–2 天）⬅ 下一个就做
**做**：给 Eva 已有的 proactive/reactive compact 补两层 Alma 有的：
1. **prepareStep 步中压缩**：多步工具循环中途 context 溢出当场压缩，不等 turn 结束。
2. **上下文钳制学习**：模型报 token 超限就把它登记的 contextWindow 永久钳小（写 settings/model_capabilities）。
3. 压缩产出格式借用 Alma 的 `<context_summary>` user 消息 + 「不要从头再来」system-reminder；摘要指令六段结构照抄。
4. **工具数 >40 安全网**：activeTools 未显式设置时退化为最小集 + 记 warning（防 MCP 接入后工具爆炸）。
**验收**：
- [ ] 构造一个超 context 的多步工具任务，跑到中途能见到 context_compaction 事件且任务不中断
- [ ] 某模型触发超限后，其 contextWindow 被钳小并持久化
- [ ] 注册 >40 工具且未设 activeTools 时，日志出现退化 warning，实际生效工具为最小集
**文档**：04 修订框（prepareStep 三路干预）/ 20 §compact / 16 §3.1-4,5 / 15 §2 compact 现状

### S20 · usage_records 补全（0.5 天，可穿插）
**做**：对齐 Alma 的 token 五元组——`cached_input / cache_write_input / reasoning` 分列（现有表补列）+ `GET /api/usage/stats` 聚合路由。
**验收**：
- [ ] 一次带 cache 的对话后，usage_records 行含 cached_input/cache_write_input/reasoning 非零值
- [ ] `curl /api/usage/stats?days=7` 返回按模型/日期聚合的用量
**文档**：18 §3 usage_records 表 SQL / 20 §15 / 14 §7.2

### S21 · refs 引用图谱（推迟，S7+S9 后评估）
**做**：`eva://` 全局对象寻址层——reference_links/reference_snippets 两表 + backlinks/graph 路由。**触发条件**：等 S9（git 对象）+ S7（task 对象）落地，kinds 能凑出 thread/message/file/task/mcp/skill ≥6 个再做，否则空转。
**文档**：20 §7 / 18 §3 reference_links/snippets / 16 §3.3-1

### S22 · auto-worktree 决策链（S9 后迭代）
**做**：抄 Alma 的五步决策链——探测 remote 默认分支 → 建 worktree → 切线程 → LLM 改分支名 → 失败回退主工作区。依赖 S9 的 git 地基，故排其后。
**文档**：20 §1（workspaces+git）/ 16 §3.1-1,§3.3-2

### S23 · preview server（S9 后迭代）
**做**：workspace 有「跑起来的东西」后，抄 Alma 五条路由（start/stop/status/detect/html-files）+ preview_servers 表 + 三档探测（bun-vite/bun-dev/static）。
**文档**：20 §1 preview 段 / 18 §3 preview_servers 表 / 16 §3.3-3

### S24 · hooks 文件型生命周期钩子（S6 前奏，~1 天）
**做**：Alma hooks.json 形态——matcher 正则 + `sh -c` + exit 2 阻断，挂在工具事件上。作为 S6 扩展宿主的低配前奏（或就是 S6 的一个内置扩展），先覆盖「用户想在工具事件挂自定义逻辑」的 80% 场景。
**验收**：
- [ ] 写一个 hooks.json 在 PreToolUse 上对 Bash 做拦截，exit 2 能阻断工具执行并回传 stderr 给模型
**文档**：16 §3.1-7 / 20 §16 hooks 小节 / 09（S6 全量设计，hooks 是其子集）

---

## 4. Phase C · 编码工作流（2 周）

### S9 · Git review 面板（1 周）
**做**：diff/commit/push/branch/worktree/MR。做成**一个扩展**挂 appSidebar + chatComposer，注册 git 命令。
> **v2 规格见 §3.5 与 20 §1**：Alma workspaces 的 30 条 git 路由里只抄子集（status/stage/diff/commit/log/branches/generate-commit-message），不抄 rebase/stash/AI 解冲突/GitHub PR（Eva 对内 GitLab MR）。auto-worktree 决策链推迟到 S9 后迭代（16 §3.3-2）。
**验收**：
- [ ] 面板里看未提交 diff
- [ ] 提交 + 推送 + 开 MR
- [ ] worktree 隔离试改
- **文档**：03 `/api/workspaces/:id/git/*` / 10 slots 实战
- **关键**：**S9 = S6 的验收扩展**（09 §13）。别单独做玩具 hello-ext，直接拿 Git 面板当 S6 的真实验收——槽位系统一上来就有真实负载。

### S10 · 数据源 Gateway 抽象（1 周）
**做**：域抽象（database RPC + 外部 HTTP 代理）+ AK/SK service credential。
**验收**：
- [ ] 注册一个外部数据源（如一个内部 API）
- [ ] agent 经 Gateway 查到数据，不直连外部
- [ ] 无登录用户场景（BFF/CI/后台脚本）用 AK/SK 鉴权
- **文档**：WeaveLynx datasource:* skill 特征（新设计，无 Alma 对应）
- **接缝**：本地优先下 Gateway 是「预留接口缝」，S10 做最小域抽象即可，不上服务端

---

## 5. Phase D · 成品（1 周 + 持续）

### S11 · 桌面化补完（持续）
> **v2 修订（2026-08-21）**：深链协议名 `myagent://` → `eva://`（对齐 15 篇）；删去「WS 全双工改造」（SSE 已够用）；单实例锁已在 r3 T11 Step 6 完成（移出待办）。**最新任务定义以 15 篇 §S11 为准**，施工拆分到 `docs/plans/r8/`（T32–T35）。
**做**：electron-updater（GitHub Releases 起）+ 托盘 + 全局快捷键 + 深链 `eva://` + 窗口状态记忆 + 自启动 + 安全收口（CSP + loopback token）。（单实例锁 ✅ T11 已做）
**验收**：
- [ ] 打 dmg 能装；启动后检查更新能拉到新版本
- [ ] 托盘 + Alt+Space 唤起主窗
- [ ] 深链 `eva://thread/xxx` 能跳转
- [x] 单实例：第二次启动聚焦已有窗口（T11 已完成）
- **文档**：02 §4 / §6 / §9.6 / §9.8 + 21 §5/§6 + **施工卡：`docs/plans/r8/`（T32–T35）**
- **坑**：mac 未签名包 checkForUpdates 静默失败（02 §9.6）；open-url 可能早于 ready（02 §9.8）；will-quit 注销快捷键；CSP 走 server 响应头不走 meta（Eva renderer 是 HTTP 托管，r8 §0.2 #2）

---

## 6. Phase E · 调味（按需，想「活物感」才做）

与编码平台目标正交，最后挑。全部来自 05/07，本地优先下都可选。

| 任务 | 验收 | 文档 | 备注 |
|---|---|---|---|
| S12 记忆（简化） | MEMORY.md+日记+searchMemory（先 FTS/grep，向量后加）；「我喜欢吃汉堡」明天还记得 | 05 §8 P0 / §9 | 偏 coding 可跳过，只留项目级 CLAUDE.md |
| S13 人格/疲劳 | SOUL.md+fatigue.json，疲劳影响语气 | 05 §5.3 | 调味 |
| S14 Heartbeat | cron 定时唤醒，检查待办 | 05 §5.2 | 主动行为 |
| S15 Activity Recorder | 截屏+OCR+会话切分+语义搜索 | 05 §4 | **隐私敏感最慎，最后做** |
| S16 多通道 | TG/Discord/飞书之一汇入消息管线 | 05 §7 | 通道换你的目标平台 |
| S17 本地语音 | Whisper STT + 本地 TTS sidecar | 05 §6 | 长尾 |

---

## 7. 最该照抄的六块金子 / 最该推迟的

**照抄（Alma+WeaveLynx 双重验证）**：
1. AI SDK 直接转发 chunk，别造协议（03/04）
2. UIMessage 整存 + 版本树 parent/slot/depth（03）
3. tool-overflow（04，30 行）
4. Skill 三级渐进披露（04）
5. fork-join + resume + depth/delegates 四层隔离（08）
6. 壳走 IPC / 业务走 HTTP 的窄桥（02）

**推迟（个人助手特有，与编码平台正交）**：人格、疲劳、Heartbeat、Activity Recorder、多通道、本地语音——全部 Phase E，先不做。

---

## 8. 任务依赖图

```
已完成：S0 S1 S1.1 S2(地基) S3 S5 S8 ── 记忆/compact 超预期

剩余关键路径（v2 重排）：
  S18(审批收尾) ──> S19(AutoCompact+安全网) ──> S7(子代理+崩溃补跑)
                                                      │
  S24(hooks 前奏) ──> S6(扩展宿主) ──> S9(Git面板=S6验收扩展)
                                                      │
                                              S22(auto-worktree)/S23(preview)  ← S9 后迭代
  S21(refs)  ← 等 S7+S9 的对象凑齐 ≥6 kinds 再评估
  S20(usage 补全)  ← 低耦合，任意穿插
  S11(桌面化)  ← 可与 B/C 后期并行
  S12–S17(Phase E)  ← 全独立，按需
```

**关键路径**：`S18 → S19 → S7 → S24 → S6 → S9 → S11`（v2 重排）。
- **S18/S19 最先**：S4 遗留收尾 + 规格最新鲜，半天到两天，先清掉。
- **S7 提前**：欠债最少（R1 摘掉的半成品）+ v2 子代理持久化规格最完整（20 §3 有 resume prompt 原文），比 S6 小，先拿下。
- **S6 放后面**：最重（1–2 周），用 S24 hooks 暖场降低空手启动难度；S9 是它的验收扩展，紧随其后。
- 旧 v1 关键路径 `S0→…→S4→S6→S9` 的前半段已完成，S8 提前完成移出，故重排。

---

## 9. 开工前清单（Checklist）

- [x] 三个决策已定（本地优先 / Claude / mac-only）—— §1
- [x] 切片体系统一到 S（弃 M）—— §0
- [x] 前端目录/命名约定就位（10 篇）—— S0/S1 直接用
- [x] 扩展槽位设计就位（09 篇）—— S6 照着做
- [x] 文档系列一致性校验通过（命名/槽位/目录/技术栈/接缝）—— 6 类无冲突
- [ ] **你确认 Anthropic API key 可用**（S1 streamText 跑起来的前提）
- [ ] **你确认有 mac arm64 开发机**（mac-only 决策的前提）

后两项是外部依赖，文档帮不了你。确认后从 S0 开写。

---

## 10. 每个 Phase 的「完成定义」

不是「代码写完」，是「验收全绿 + 无结构债」：
- 每片 PR 通过 10 §10「反模式」检查 + 10 §9 feature 隔离 lint
- 流式相关切片（S1/S7）必须当场验流式不顿挫、不丢不重
- S6/S9 必须有真实扩展跑通，不是 hello world
- 结构债不留下一切片（shared 提升及时、feature 隔裂及时修）

**开工第一句**：`S0 地基对齐`，从 `electron-vite` 脚手架 + 10 §2 目录骨架开始。
