# 14 · Eva 技术架构：基于 Alma × WeaveLynx 的取舍

> 本文是 Eva（本仓库）的目标技术架构，综合两份调研沉淀：
> - **Alma**（docs 00–13）：本地优先 AI 桌面助手的全栈形态——内嵌后端、AI SDK、UIMessage 整存、多模型槽位、SKILL.md、fork-join、扩展槽位。
> - **WeaveLynx**：`@weavelynx/agent` 的会话运行时封装——派生状态、投递台账、流式合流、迟到补偿、pessimistic-commit、子代理终态收割。
>
> 取舍原则：**Alma 给"形态"（进程模型、数据模型、扩展体系），WeaveLynx 给"纪律"（状态派生、流式工程、时序补偿）。** 标注约定：【现状】= 本仓库代码已存在；【目标】= 本架构要落地；【放弃】= 明确不做。

---

## 0. 一句话定位

Eva 是一个**本地优先的 work agent 桌面应用**：Electron 壳 fork 一个内嵌 Fastify 服务（仅绑 `127.0.0.1`），harness 基于 Vercel AI SDK 手写 agent loop，SQLite 单库存会话/消息/记忆/配置，能力靠 SKILL.md + MCP + 扩展槽位热插拔，复杂编排沉淀为 skill 而不是主循环代码。

---

## 1. 设计哲学（从两个参照物偷来的 12 条原则）

| # | 原则 | 出处 | 落到 Eva 的哪里 |
|---|---|---|---|
| 1 | **本地优先，loopback 即信任边界**；审批只防"AI 乱来"，不防本机进程 | Alma §03 | server 只绑 `127.0.0.1`，拒绝 `0.0.0.0`（【现状】已有） |
| 2 | **一套 API 服务所有客户端**（renderer、CLI、未来浏览器扩展/移动端） | Alma §00 | Fastify 独立 UtilityProcess，HTTP+SSE 唯一入口（【现状】已有） |
| 3 | **不自造 chunk 协议**：直接转发 AI SDK 的 stream parts | Alma §04 | §6 流式协议（【目标】，替换现有自定义 SSE 事件） |
| 4 | **UIMessage 整存**：消息以 SDK 内存对象整体 JSON 落库，读写零转换 | Alma §03 | §7 数据架构（【目标】，替换现有平铺 messages 表） |
| 5 | **多模型槽位**（chat / toolModel / vision / embedding），子代理一律用便宜模型 | Alma §04 | §4.1（【部分现状】providers 表已有，槽位设置待做） |
| 6 | **主循环只提供原语，编排模式写成 skill**（council/harness/DAG 全是 markdown） | Alma §08 | §4.6（【目标】） |
| 7 | **子代理 = 递归的同一条 loop** + 换 system prompt + 换便宜模型；不写第二套引擎 | Alma §08 | §4.5（【部分现状】subagents/executor 已有骨架） |
| 8 | **能算出来的状态都是 getter，不是字段**：session.status 纯派生，单一事实源多投影 | WeaveLynx §1.3 | §5.2（【目标】） |
| 9 | **每条用户输入有可观测的生命周期台账**，崩溃恢复尊重下游去重语义 | WeaveLynx §1.4 | §5.3（【目标-简化版】） |
| 10 | **finalize 不是终点**：给迟到副作用留补偿窗口，时序 bug 变可自愈 | WeaveLynx §7.3 | §5.5（【目标】） |
| 11 | **pessimistic-then-commit**：先下游成功才改本地状态；UI 乐观回显 + 不可见时回撤 | WeaveLynx §7.4 | §5.6（【目标】） |
| 12 | **实测常量即规格**：黑盒依赖的经验值集中管理 + 回归测试钉死 | WeaveLynx §7.1 | §13（【目标】） |

**同样重要的是"不偷什么"**（详见 §15）：WeaveLynx 的 SDK 子进程重启机器（MessageStream cut / uuid 重铸）源于它封装 claude CLI 子进程，Eva 直连 AI SDK 没有这层，不照搬；Alma 的全能工作台面（Telegram/Discord/微信/飞书、情感疲劳、屏幕活动记录）是 Phase E 的 flavor，不进核心架构。

---

## 2. 进程与部署架构【现状，S0 已落地】

```
┌─────────────────────────── Eva.app (Electron, macOS arm64) ──────────────────────────┐
│                                                                                      │
│  Main Process (apps/desktop/electron/main.ts)                                        │
│   ├─ fork server 为 UtilityProcess（动态 localhost 端口，健康探测 /v1/health）         │
│   ├─ shell-env 修复、代理处理、窗口管理、preload bridge                                │
│   └─ Phase D：electron-updater / tray / Alt+Space 唤起 / eva:// deep link / 单实例     │
│                                                                                      │
│  ┌── UtilityProcess: Fastify server (apps/server) ────────────────────────────────┐  │
│  │  127.0.0.1:<dynamic port>                                                      │  │
│  │   ├─ REST /api/v1/*（runs / threads / providers / models / settings / skills / │  │
│  │   │   memories / approvals / search）                                          │  │
│  │   ├─ SSE  POST /api/v1/runs/stream                                             │  │
│  │   ├─ deps.ts（基础设施）→ services/（业务装配）→ app.ts（生命周期）三层           │  │
│  │   └─ better-sqlite3 + drizzle（WAL）→ 用户数据目录                               │  │
│  └─────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                      │
│  Renderer (apps/web, React 19 + Vite)                                                │
│   └─ fetch REST + fetch ReadableStream 消费 SSE（不用 EventSource，因为要 POST）       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**与 Alma 的关键差异**：Alma 把后端跑在 Electron 主进程内；Eva 把 server fork 成独立 UtilityProcess。代价是多一层进程管理，收益是：

- server 崩溃不拖垮桌面壳，重启 server 不掉窗口；
- `pnpm dev` 时 server 可以脱离 Electron 独立跑（Web 开发不需要起桌面端）；
- 未来 server 可被 CLI、浏览器扩展等其他宿主复用（Alma 的 CLI 也是打同一个 HTTP API）。

**端口**：动态分配 + 健康探测，不写死 Alma 的 23001 风格固定端口（避免多实例冲突）。renderer 经 preload/注入拿到端口，不硬编码。

---

## 3. 分层总览

```
apps/web          表现层：聊天 UI、流式渲染、设置、审批卡片、槽位容器
   │  HTTP / SSE
apps/server       服务层：路由 → services → repositories；审批网关、compact、
   │              provider runtime、memory runtime、workspace
   │
packages/harness  内核层：agent loop（streamText + stopWhen）、模型适配、
   │              工具集、tool-overflow、子代理 fork-join、skill 加载、
   │              prompt 组装、context 策略（compact、budget、续写）、observer 遥测
   │
packages/shared   契约层：跨 server/web/desktop 的类型与事件契约（zod）
```

依赖方向严格向下：`web → server → harness → shared`。harness 不认识 Fastify，server 不认识 React——harness 通过接口拿到模型/工具/存储句柄，保证未来可以被 CLI 等其他宿主复用。

---

## 4. Harness（agent 内核）目标架构

### 4.1 模型适配：AI SDK 原生 + 多模型槽位

【现状】harness 已迁到 `ai@^7` + `@ai-sdk/anthropic` + `@ai-sdk/openai-compatible`（LangChain 手写 tool_call 碎片重组已删）。

【目标】

- **不自造 provider 抽象层**。直接消费 AI SDK 的 `LanguageModel` 接口；server 侧 `provider-runtime` 负责"providers 表配置 → `createXxx({apiKey, baseURL})` → LanguageModel 实例"的解析。新增 provider = 加一个 `@ai-sdk/*` 包 + 注册表一行。
- **多模型槽位**落 settings：`chat`（主对话）/ `toolModel`（子代理与摘要等杂务，便宜 5–10×）/ `vision` / `embedding` / `compact`。`depth > 0` 的子代理与 compact 摘要强制走 `toolModel`。
- **pessimistic-then-commit 切模型**：改模型设置先做一次轻量探活（或标记待验证），成功才 commit settings 并广播；失败保留旧值并回报错误。

### 4.2 agent loop：streamText + stopWhen，保留已有的上下文控制

【现状】`LeadAgent` 手写 maxSteps loop，已有：proactive/reactive runtime compact、tool-result budget、max-output 续写恢复、observer 遥测。这些是 harness 最有价值的资产，**保留控制逻辑，只让 SDK 干 SDK 的活**。

【目标】

- loop 收敛为 `streamText({ model, system, messages, tools, stopWhen: [stepCountIs(N)], abortSignal, onChunk, onFinish, onError })`；步骤边界由 SDK 的 step 语义给出。
- **abort**：`AbortController` 按 run 注册，SSE 断连/用户 stop → abort。abort 只停主 loop，**不杀后台子代理**（对齐 WeaveLynx：后台任务必须活过 Stop；停单个后台任务走独立的 `stopTask`）。
- **不撤销已进模型的用户输入**（WeaveLynx 的教训："以为撤了其实进模型"比"撤不掉"更糟）。UI 上用可见标记区分"已进模型"与"排队中"。

### 4.3 工具系统与两道上下文防线

【现状】fs 工具组（bash/read/write/edit/grep/list + **tool-overflow 已有**）、web-search、web-fetch、memory 工具、task 工具；工具约定为 PascalCase 文件夹三件套（constants/description/index）。

【目标】

- 工具 = AI SDK `tool({ description, parameters: zod, execute })`，`toToolSet()` 汇总。description 写清"什么时候该用"（Alma 经验：触发时机比参数说明重要十倍）。
- **防线一：tool-overflow**（已有，继续）——单条输出超阈值截断 + 落盘 `tool-overflow/*.log` + 返回"用 Read offset/limit 续读"的指引。
- **防线二：compact**——proactive（token 估算超阈值提前压）+ reactive（模型报 context 错误后压缩重试）+ 手动 `POST /threads/:id/compact`（【现状】三件套已有雏形：auto-compact / compact / session_compactions 表 / token-estimator）。摘要用 `toolModel`。旧消息标记 archived 不删，留审计。
- **toolCallId 配对一字节不改**：模型的 tool_call id 原样透传到 result（Alma §08 的硬规则）。

### 4.4 审批闸门【部分现状】

【现状】`approval_requests` 表 + `approval-gateway` service + 前端 `approval-card` / `use-approvals` 已通。

【目标】对齐 WeaveLynx 的 **InteractionBroker** 模式：

```
危险工具（Bash/Write/Edit/MultiEdit…）execute 外层包 withApproval 高阶函数
  → broker.request(toolCallId, args)：建 deferred promise，落 approval_requests(pending)
  → SSE 推 approval_request 给前端，session 派生态进 requires_action
  → 用户点允许/拒绝/始终允许 → resolve/reject deferred
  → SDK 侧 await 该 promise 作为 execute 的前置闸门；reject = hard deny
  → abort / run 结束 / destroy 时 cancelAll 统一 reject（不会永远吊着）
```

- `settings.security.autoApproveToolRequests` + 工具级白名单（"始终允许"写 per-tool 记忆）。
- broker 的变化通知 try/catch 包住：UI 回调挂了不能弄坏 broker 内部不变式（WeaveLynx `#safeChange` 教训）。

### 4.5 子代理：fork-join 双原语

【现状】`subagents/`（registry / executor / builtins/general-purpose）+ `tools/task` 已有骨架。

【目标】Alma §08 的完整语义：

- **两个工具**：`Task`（fork：`subagent_type` / `prompt` / `run_in_background` / `resume`）+ `TaskOutput`（join：`taskId` / `block`）。
- **默认前台**。引导文案照抄 Alma："Prefer foreground execution so the user can watch the agent's progress stream inline. Use run_in_background only when concurrency matters more than live visibility." 可见性 = 成本熔断器。
- 子代理 = **递归的同一条 loop**：换 system prompt（crew 注册表注入角色）+ 强制 `toolModel` + 深度 `depth+1`。
- **四道成本阀**：① 子代理用便宜模型；② final answer 是唯一出口（中间过程进子代理自己的消息树 `parent_tool_call_id`，不进主上下文）；③ `MAX_DEPTH` 硬闸 + `allowedDelegates` 白名单让委派图有向无环；④ 子代理上下文关 `parallelToolCalls`（Alma 的 `Lt` 闸门——受控环境里不允许不可控并发写）。
- **resume**：子代理 transcript 不销毁，`Task(resume: taskId, prompt)` 带全部记忆续聊——从一次性外包变成可反复咨询的同事关系。
- **后台任务表**：`{ status: running/done/failed, result, error, transcript }`，异常必须写 `failed + error` 透出（吞了 join 方永远 block）；join 必须有超时 + 超时返回 partial。
- **终态收割**（WeaveLynx）：后台子代理活过派生它的 run，进行中不属于任何 run，终态后由观察到它完成的那个 run 收编。归属按终态、按观察者。
- **ctx 信封不变式**：子代理流式事件必须带 `{ parentMessageId, parentPartId }`，否则主线程订阅者解析不出、子代理卡片永远停"运行中"。这个不变式**收敛到一个 emit 入口函数强制注入**，不靠每个站点手工维护（WeaveLynx 妥协 3 的教训）。
- 子代理消息经 `GET /threads/:id/subagent-messages` 暴露给前端（对齐 Alma），用户在主对话点开看全过程。

### 4.6 Skill 渐进披露与编排模式

【现状】`skills/`（loader / parser / prompt / read-skill-tool）三级渐进披露已基本完成（S5）。

【目标】

- 三级披露不变：启动只注 `(name, description)` → agent 调 skill 工具读全文 → 附属文件按需 Read。
- **编排模式全部写成 skill**（council / gan-harness / rfc-dag），主 loop 只认识 Task/TaskOutput 两个原语。新增编排 = 写 markdown，不动运行时代码——机制在内核，策略在用户态。
- 编排若可能跨小时/跨天，状态机落库（对齐 Alma `agent_missions.harnessMode/currentPhase/maxIterations`），不做纯内存流程。

### 4.7 MCP【目标，S8】

- `mcp.json` + DB `mcp_servers` 表双来源；工具以 `mcp__<server>__<tool>` 动态注册进 tools 对象；OAuth token 落 `mcp_oauth_tokens`。
- 与 skill 的分工：skill 教 agent"做法"（流程/规范/模板），MCP 接外部 SaaS/本地服务的新工具。

---

## 5. 会话运行时：领域模型与状态纪律

这一层是 WeaveLynx 给 Eva 最大的礼物。**Eva 不需要抄它的实现（它封装的是 claude CLI 子进程），但必须抄它的状态纪律。**

### 5.1 领域模型：Session / Run / Message / Part

```
Session  一条会话：id / title / model / mode / workspaceId / 累计 token / contextUsage
  └─ Run      一轮执行：一次用户输入触发的完整 agent loop
       │      { userMessages[], assistantMessage, status, subagents(终态收割) }
       ├─ Message  一条消息（UIMessage 整存，见 §7）
       └─ Part     消息部件：text / reasoning / step-start / tool-<NAME> / file
```

【现状】Eva 只有 sessions + messages 两层，run 是隐式的（POST /runs/stream 一次性跑完）。【目标】Run 提为一等概念：一次 run = 一次 onRun 持久化 + 一次 STREAM_END 评估。子代理、审批、compact 都挂在 run 边界上。

### 5.2 派生状态，不是存储状态【目标】

`session.status` **不落库**，由 `deriveSessionStatus()` 纯派生，按优先级取首个命中：

| 状态 | 条件 | 可回收？ |
|---|---|---|
| `requires_action` | 有审批待答（approval pending） | 否 |
| `running` | run 在飞，或有已发送未认领输入 | 否 |
| `waiting` | 主 loop 闲 + 有存活后台任务 | 否（禁止回收） |
| `idle` | 无上述 | 是 |

单一事实源 + 多投影：凡是能从其它量算出来的"状态"，都是 getter。这从根上消灭"多份可变状态互相不一致"这一类 bug。

### 5.3 输入投递台账（简化版）【目标】

WeaveLynx 的四级阶梯（buffered→yielded→queued→started）是为"SDK 子进程可能崩、buffer 要跨重启存活"设计的。Eva 的输入走 HTTP 直达 server，没有 CLI 子进程，**阶梯简化为三级**：

| 阶段 | 打点 | 含义 |
|---|---|---|
| `accepted` | POST 落库 user message 成功 | 输入已持久化，崩溃不丢 |
| `started` | run 懒开启（第一条属于新 run 的流事件到达） | 真正进模型 |
| `claimed` | run 认领该 user message 进 `Run.userMessages[]` | 参与本轮上下文 |

派生量 `owedInput = 未 claimed 的已 started 输入 > 0`，同时驱动 `session.status` 与 STREAM_END 门。

保留 WeaveLynx 的两条 UX 纪律：

- **乐观回显 + 回撤**：用户消息先上屏；若从未 `started` 就被 abort/discard，发 `message/remove` 回撤幽灵气泡。
- **steer（中途插队）**：run 在飞时的新输入，进模型后落成该 assistant message 的一个 `user` part（fold 点可见标记：上面是没读到它时产出的，下面是带着它产出的）——用户必须能精确感知"我这句话到底算不算进去了"。

### 5.4 turn 懒开启与 STREAM_END

- 看到第一条属于新 run 的流事件时才创建 Run（认领全部"已 started 未认领"输入）——而不是收到 POST 就创建（防止空 run）。
- **STREAM_END = `session.status → idle` 这唯一一条边**，外加一个 watchdog 到期复查（WeaveLynx 用 500ms）。唯一的无条件 STREAM_END 出口是 destroy。

### 5.5 late-arrival 窗口：finalize 不是终点【目标】

场景：abort 时写盘副作用（Write/Edit）已落盘，但 tool_use/tool_result 晚于 run finalize 到达，DB 里没痕迹。WeaveLynx 的解法照抄：

- run finalize 后开 **5s late-arrival slot**，迟到消息路由进旧 run；
- 带 debounce 的 `onRun` 重发做持久化补偿。

承认分布式时序不可消灭，给补偿通道而不是硬终点。这把"DB 里没痕迹"这类最难查的 bug 变成可自愈。

### 5.6 配置推送：pessimistic-then-commit【目标】

所有会改变运行时行为的设置（模型 / mode / 系统提示词 / MCP 配置）：

```
先应用（探活/RPC）→ 成功才 commit 本地 settings → 广播 settings/changed
失败 → 保留旧值，返回错误，UI 回滚
```

一致的 fail-safe 方向：宁可回撤，不可"以为生效了其实没生效"。

---

## 6. 流式协议【目标：替换现有自定义协议】

### 6.1 直接转发 AI SDK stream parts，不自造协议

【现状】SSE 事件是自定义的 `text_chunk / tool_call_start / tool_call_end / result / error / end`。【目标】对齐 AI SDK v5（`ai@7`）`UIMessageChunk` 命名——Alma 实证的最优解：后端原样转发 SDK chunk，前端按 SDK parts 语义重组，**不写自己的中间表示**。

```
POST /api/v1/runs/stream  (SSE, fetch + ReadableStream)
├─ message_start / message_delta            一条 assistant 消息开始/元信息
├─ text-delta / reasoning-delta             正文/思考 token 增量
├─ tool-input-start / -delta / -end         工具入参流式
├─ tool-call / tool-result                  工具调用完成/结果回填
├─ step-start                               一个 agent step 分界
├─ approval_request / approval_resolved     审批桥（Eva 自有域事件）
├─ subagent_update                          子代理域事件（带 ctx 信封）
├─ finish / error / end                     收尾
```

规则：AI SDK 域的事件名与 SDK 逐一对齐；Eva 自有域（审批/子代理/会话状态）才允许自定义，且与 SDK 命名空间隔离。

### 6.2 增量合流纪律（WeaveLynx 双通路经验）

- **coalesce 窗口**（~100ms）批量发 text-delta；首个 delta 走 microtask 立即发（首 token 尽快上屏）。
- tool_use 的 `input_json_delta` 用 partial-json 解析半截 JSON，带**增长门槛**（小输入 64B、大输入 len/8，把 O(N²) 解析压成 O(N log N)）+ **stall 逃生门**（500ms 无进展强制发一帧）。
- **settle 帧永远带全量 value 作为收敛点**——不靠序号/重同步通道。断线重连后 `GET /threads/:id/messages` 全量对齐。
- 增量 part 与完整帧合流：内容全等 + 同类 + 未认领 ⇒ 复用增量 part 不发事件（不重）；miss 走正常 upsert（不丢）。

### 6.3 前端三红线【目标，S1.1】

1. **seq reorder**：乱序到达的增量按序号归位再渲染；
2. **rAF char pump**：字符泵按帧吐出，token 爆发时不卡顿；
3. **Streamdown block memo**：只有尾部 block 重渲染，历史 block 全 memo。

【现状】`shared/streaming/`（delta-accumulator / use-smooth-stream）已有基础。

---

## 7. 数据架构【目标：S2 重构核心】

### 7.1 总原则

- **SQLite 单库**（better-sqlite3 + drizzle，**WAL 必开**），drizzle-kit 增量迁移（`ALTER TABLE ADD COLUMN` 是 SQLite 安全的增量方式）。
- **结构化数据进库，记忆/人格/技能进人类可读 Markdown 文件**（文件是真相，库是索引——Alma 哲学，调试成本极低）。
- **UIMessage 整存**：`messages.message` TEXT 列存整个 AI SDK UIMessage JSON `{id, role, parts[]}`，读写零转换；part 级检索靠 FTS5/JSON 函数补。

### 7.2 目标 schema（在现有表上演进）

```sql
-- 会话（现 sessions 表演进）
chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT,                        -- "providerId:modelId"
  is_generating INTEGER DEFAULT 0,
  workspace_id TEXT REFERENCES workspaces(id),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT, updated_at TEXT
);

-- 消息（核心重构：现 messages 平铺表 → UIMessage 整存 + 版本树三件套）
chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  parent_id TEXT,                    -- 版本树：父消息
  slot_id TEXT,                      -- 版本槽：同一对话位置的重生成版本共享
  depth INTEGER DEFAULT 0,           -- 对话树深度
  parent_tool_call_id TEXT,          -- 子代理消息树归属
  role TEXT NOT NULL,                -- 冗余便于查询
  message TEXT NOT NULL,             -- ★ 完整 UIMessage JSON
  metadata TEXT NOT NULL DEFAULT '{}',  -- usage / model / 耗时
  created_at TEXT
);

-- 已有表保留：providers / settings / approval_requests / session_compactions
-- 新增：
workspaces (id, path, name, is_temporary, is_worktree, parent_workspace_id,
            worktree_branch, pr_number, pr_url, created_at, updated_at);
usage_records (id, message_id, thread_id, model, provider_id,
               input_tokens, output_tokens, cached_input_tokens,
               reasoning_tokens, total_tokens, created_at);
memories (id, category, content, metadata, source_session_id, user_id,
          embedding_status, created_at, updated_at);   -- 【现状】已有
memory_embeddings (vec0 虚表, memory_id TEXT PRIMARY KEY, embedding FLOAT[384]);
messages_fts (FTS5 虚表: message_id, thread_id, content);  -- 全文检索
mcp_servers / mcp_oauth_tokens;      -- S8
plugins / plugin_permissions;        -- S6
background_tasks (id, thread_id, parent_tool_call_id, status,
                  result, error, transcript, created_at, settled_at);  -- fork-join
```

- **版本树三件套**（`parent_id + slot_id + depth`）是实现"重新生成 / 版本切换 / 分支"的最小模型，照抄 Alma。
- **落库时机**：`onFinish` 拿到完整 assistant UIMessage 才 `JSON.stringify` 落库 + 写 usage_records；流中途只推送不落库，避免半成品。
- **断线续传**：`is_generating` + 最后落库消息；客户端重连后全量拉取对齐。

### 7.3 文件布局

```
~/.config/eva/  （或 Application Support/eva）
├── eva.db (+ -wal/-shm)        唯一 SQLite 库
├── SOUL.md                     人格/底线（常驻注入）【现状：prompts/soul.ts 已有雏形】
├── MEMORY.md                   长期记忆（常驻注入）
├── memory/YYYY-MM-DD.md        每日笔记
├── skills/<name>/SKILL.md      用户技能
├── mcp.json                    MCP 配置
├── extensions/<id>/            扩展包（S6）
├── tool-overflow/*.log         超长工具输出（【现状】已有）
└── workspaces/<id>/            工作区（agent 的 cwd，S3）
```

---

## 8. API 面【现状 + 目标增量】

【现状】已通：`/v1/health`、`/api/v1/runs/stream|wait`、`/api/v1/threads`（CRUD + messages + compact）、`/api/v1/providers`、`/api/v1/models`、`/api/v1/settings`、`/api/v1/skills`、`/api/v1/memories`、`/api/v1/approvals`、`/api/v1/search/threads`。

【目标】增量（按 Phase 排）：

```
POST /api/v1/messages/:id/switch-version      版本树切换（S2）
GET  /api/v1/threads/:id/subagent-messages    子代理消息树（S7）
GET  /api/v1/threads/:id/context-usage        token 用量查询
GET/POST /api/v1/workspaces …                 工作区 CRUD + 文件 + git（S3/S9）
GET/POST /api/v1/mcp-servers …                MCP 管理（S8）
GET/POST /api/v1/plugins … + GET /api/v1/slots 扩展与槽位（S6）
POST /api/v1/chat/completions                 OpenAI 兼容端点（供外部工具复用 Eva 的模型，可选）
```

不追求 Alma 的 404 条路由。**路由增长只跟着切片验收走**——每条路由都要能回答"哪个 S 任务验收它"。

---

## 9. 桌面壳【现状 + Phase D】

【现状】`apps/desktop/electron/main.ts + preload.ts`：fork server、动态端口、健康探测、shell-env、代理（S0 完成）。

【目标 · Phase D / S11】electron-updater 自动更新、托盘、Alt+Space 全局唤起、`eva://` deep link、单实例锁、窗口状态记忆。打包 electron-builder + asar，sqlite-vec 等原生二进制列 `asarUnpack` / `extraResources`（Alma 实证打包坑：Electron 打包后 `require.resolve` 路径失效）。

---

## 10. 扩展宿主（S6）【目标】

照 09 篇设计落地，此处只留决策：

- **4 个 UI 槽**（`chatComposer` / `chatSidebar` / `chatHeader` / `appSidebar`）+ **6 类能力槽**（skill / mcp / subagent / tool / command / template）。
- 两文件契约 `manifest.json`（身份+contributes）+ `exposes.json`（槽位映射+API+权限），zod 纯数据校验先行，**不执行扩展代码就完成校验**。
- EH 起步为主进程内隔离模块（不拆独立进程），懒激活（用到槽位/能力才 activate）。
- **能力槽注入只改数据来源**：runAgent 的注入点从"直接读 DB/文件"改成"查 EH Registry"，agent loop 一行不动——主循环不认识"扩展"，只认识 registry。
- 命名空间防冲突：工具 `ext.<id>.<name>`，skill `<id>/<name>`，校验阶段拒重。
- **S6 的验收扩展直接就是 S9 Git 面板的雏形**——槽位系统立刻有真实负载，不做玩具 hello-ext。

---

## 11. 记忆系统【部分现状 + Phase E】

【现状】`memories` 表（category/origin/embeddingStatus）+ memory-runtime / memory-recall / memory-embedding services + save/search memory 工具已存在，走分类 + 待嵌向量路线。

【目标】对齐 Alma 四层 + WeaveLynx 纪律：

| 层 | 载体 | 注入/检索 |
|---|---|---|
| L1 长时记忆 | `MEMORY.md`（+ `SOUL.md` 人格） | 会话开始全文注入 |
| L2 每日笔记 | `memory/YYYY-MM-DD.md` | 最近 1–2 天注入 |
| L3 会话归档 | `chat_messages` + `messages_fts` | FTS5 关键词检索 |
| L4 语义索引 | `memory_embeddings`（vec0, 384d） | sqlite-vec KNN |

- **混合检索**：向量 KNN + FTS5 两路召回，RRF 融合（k=60），Top-N 带 token 预算（~1200）按条目粒度截断，注入 `## Relevant Memories` 段 + 来源标注 + "这只是切片，用 searchMemory 深挖"的机制说明。
- **embedding 本地化**：transformers.js + all-MiniLM-L6-v2（中文换 multilingual-e5-small），q8 约 23MB，后台预热；模型未就绪自动降级纯 FTS，**disabled, not crash**。
- **增量索引**：`content_hash` 变了才重嵌；vec0 无 UPDATE，改向量 DELETE+INSERT。
- **四个记忆工具**：searchMemory / readMemoryFile / appendMemory / updateLongTermMemory（强调 REPLACES whole file，防模型传增量冲掉旧记忆）；写工具进程内互斥锁串行化。
- **睡眠整理**（Phase E）：cron 扫库，exact/expired/orphan/similarity/LLM 五类原因归档进 `memory_archive`（合并而非删除，可追溯），运行统计落 `memory_sleep_runs`。
- 反模式：不做云端 embedding 默认路径（破坏隐私边界）；不绕过归档直接删记忆。

---

## 12. 安全与信任模型

- **绑定 loopback 即裸奔边界**：`127.0.0.1` 无 token；`HOST=0.0.0.0` 直接拒绝启动（【现状】已有）。要远程暴露必须先加 token 中间件 + TLS，不在本期范围。
- **审批只防 AI 乱来**：危险工具走 §4.4 审批闸门；本机其他进程的信任问题不在桌面单用户模型的范围内。
- **API key 加密存储**，任何 API 响应不回传明文。
- **webview/扩展隔离**：扩展前端 `contextIsolation` 开、`nodeIntegration` 关；槽位上下文（URL query 注入）不可信，必须校验 extensionId+slot 在注册表；权限在 EH 后端强校验，前端只做灰显。
- **输入不可信**：工具入参防路径穿越（readMemoryFile 式工具必须 resolve 后校验前缀）。

---

## 13. 观测与测试策略【目标】

- **observer 遥测**（【现状】harness 已有）：token usage / loop 转换 / compact 原因 / 工具耗时，结构化事件落 `usage_records`。
- **实测常量集中管理**（WeaveLynx 教训）：coalesce 100ms、stall 500ms、late-arrival 5s、watchdog 500ms、MAX_DEPTH、join timeout、tool-overflow 阈值、记忆预算 1200 tokens——全部收进一个 `constants.ts`，每个值附"为何取此值"的注释，并配回归测试钉死。AI SDK 升级时优先回归这组测试。
- **E2E 验收跟着切片走**：每个 S 任务的验收标准即测试用例（README Roadmap 表已定义）。

---

## 14. 现状对照与路线图

| 架构层 | 现状 | 缺口 → 任务 |
|---|---|---|
| 进程/部署 | ✅ S0 完成（fork + 动态端口 + 健康探测） | Phase D 桌面打磨（S11） |
| 模型适配 | ✅ ai@7 + anthropic + openai-compatible | 多模型槽位设置（随 S1 收尾） |
| agent loop | ✅ streamText + compact/budget/续写/observer | 与 SSE 协议对齐收尾（S1） |
| 流式协议 | ⚠️ 自定义事件（text_chunk/tool_call_*） | 切到 AI SDK chunk 命名 + 前端三红线（S1.1） |
| 消息存储 | ⚠️ 平铺 role/content 表 | UIMessage 整存 + 版本树（S2） |
| 会话运行时 | ⚠️ run 隐式、状态分散 | Session/Run 领域模型 + 派生状态 + 投递台账（S2 同期） |
| 工具/审批 | ✅ fs 工具组 + tool-overflow + 审批流 | Bash 持久会话、写工具审批细化（S4） |
| 工作区 | ⚙️ services/workspace 已有雏形 | workspaces 表 + 导入仓库 + CLAUDE.md 注入（S3） |
| Skill | ✅ 三级渐进披露（S5） | 编排模式 skill 化（持续） |
| 子代理 | ⚙️ registry/executor 骨架 | TaskOutput/resume/后台任务表/深度闸（S7） |
| 扩展宿主 | ⬜ | manifest/exposes + EH + 4 槽（S6，验收=S9 Git 面板） |
| MCP | ⬜ | mcp.json + 动态注册（S8） |
| 记忆 | ⚙️ 分类表 + 工具 + embedding 服务雏形 | 文件三层 + vec0 混合检索 + sleep 整理（Phase E） |

关键路径不变：**S1 → S2 → S3 → S4 → S6 → S9**。S2（消息模型重构）是本架构落地的下一个枢纽——UIMessage 整存 + 版本树 + Session/Run 领域模型一次做掉，后面的子代理消息树、subagent-messages 路由、断线续传都长在这块地基上。

---

## 15. 不做清单（明确放弃，防漂移）

1. **不封装 claude CLI 子进程**。WeaveLynx 的 MessageStream 跨重启存活、uuid 重铸、query 重启预算，全部是"SDK 是黑盒子进程"的衍生品。Eva 直连 AI SDK，进程内调用，这些机器不存在也不可惜。
2. **不自造并发原语**（无 p-limit/semaphore）：fan-out 给 SDK，调度决策给 LLM，并发度给模型自己；写冲突靠审批串行化 + 受控上下文关 parallelToolCalls。
3. **不为子代理写第二套引擎**、**不把编排写进主循环**（Alma 三不做的后两条，照抄）。
4. **不做全能工作台**：Telegram/Discord/微信/飞书多通道、情感疲劳、心跳唤醒、屏幕活动记录、TTS/STT——全部是 Phase E 的可选 flavor，与 coding 平台主线正交，任何时候都不许挤占 S1–S9 的资源。
5. **不做云端记忆**：embedding 本地跑，记忆文件本地存，没有云同步默认路径。
6. **不追 Alma 的 404 条路由**：路由增长只跟切片验收走。
7. **不给主循环加模式代码**：council/harness/DAG 永远是 markdown skill，不是 TypeScript。

---

## 附：与参照物的差异一句话总结

| 维度 | Alma | WeaveLynx | Eva |
|---|---|---|---|
| 后端位置 | Electron 主进程内嵌 | 内嵌 client-cli（hono + drizzle） | **独立 UtilityProcess（Fastify）** |
| 模型层 | Vercel AI SDK 直连 | claude-agent-sdk（CLI 子进程）封装 | **Vercel AI SDK 直连** |
| 会话状态 | 分散字段 | 纯派生 + 投递台账 | **派生纪律 + 简化三级台账** |
| 消息存储 | UIMessage 整存 + 版本树 | Part 级事件流 + DB | **UIMessage 整存 + 版本树** |
| 流式 | 直转 SDK chunk over WS | 双通路合流 + coalesce | **直转 SDK chunk over SSE + 合流纪律** |
| 扩展性 | plugin 雏形 | 槽位平台 | **槽位宿主（S6）** |
| 多 agent | fork-join + 编排 skill 化 | 子代理注册表 + 终态收割 | **fork-join + 终态收割 + 编排 skill 化** |

【全文完】


