# 04 · Alma 模型适配层 与 Agent 执行层

> 范围：从 "providers 表 + AI SDK" 到 "agent loop + 工具系统 + 子代理 + skill/MCP/插件 + 权限审批 + prompt 组装" 的完整链路。
> 证据基础：对 Alma 主进程 bundle（asar 解包后 grep）、SQLite schema、`/api/*` 实测路由、`~/Library/Application Support/alma/` 文件布局的 134 步分析。
> 标注规则：【实证】= bundle/schema/路由直接命中；【推测】= 基于实证 + AI SDK 通行做法的合理还原。

> **v0.0.990 修订（2026-08-21）**：本篇 §8 的 loop 主干（AI SDK `streamText` + `stopWhen` 驱动、WS `generate_response` 入口、UIMessage 整包落库）在 v0.0.990 **仍成立**，但围绕它新增了四块硬机制，本篇对应小节未覆盖，详见 **16/19/20 篇**：
>
> - **`prepareStep` 三路干预**（`main.readable.js:90674-90824`，本篇 §6.2 只记录到事后 compact）：① ToolSearch 动态激活——上一步 ToolSearch 结果的 `output.tools[].id` 并入后续步骤 `activeTools`（日志 `[ToolSearch:prepareStep] Dynamically activated tools:`，`:90698`）；② Gemini AttemptCompletion 提醒——已调非收尾工具但未收尾时注入 system-reminder，上限 3 次（`:90714`）；③ AutoCompact 主动压缩——步中检测 `usage` 溢出当场压缩（`aA()` 判定：有效输入 + output > contextWindow − min(maxOutput, 32000)，目标压到 60% 窗口，日志 `[AutoCompact:prepareStep]`，`:90740`）。`streamText` 选项另增 `allowSystemInMessages: !0` 与 `repairToolCall: Pg`（`:90608-90612` 同一 options 对象内）。
> - **统一审批中心**（本篇 §5 的「危险工具审批 + 子代理自动批准」已重构）：所有审批走单个 `Sy()` 函数（约 `:27880-28200`），IPC 通道 `tool-approval-dialog-show`（`:28144`）/ `tool-approval-dialog-respond`（`:27924`），决策枚举 `allow_once | allow_always | deny | deny_with_reason`；**超时自动拒绝**（上限 120s）；自动放行链七级成文（headless 环境变量 → 全局 autoApprove → `isSubagent` 子代理直放 → 渠道/群组 → 渠道 thread 映射 → cron 线程 → allow_always 记忆）。**bash 审批前置 AI 风险分析器**：本地规则快判 + 小模型二级判定（指令原文 `:33131`，枚举 safe/需批命令清单，返回 `{needsPermission, description, riskLevel: safe|low|medium|high, mightModifyFiles}`，弹窗 `source: "bash"` 在 `:33536`）。`allow_always` 是 **thread 作用域 policy key**：`bash:thread:<id>:command:<完整命令>` / `...:all`、`acp:thread:<id>:tool:<kind|toolName>`、`ptc:thread:<id>:all`（`:28080-28100`）。
> - **`run_script` 沙箱化 PTC（Programmatic Tool Calling）**：由 `injectPtcExecutor` 动态注入（`:82023`，settings `advanced.programmaticToolCalling` 默认开），沙箱 preamble 提供 `almaTool/listTools/sh/alma` 四原语，工具回调走 `POST /api/tools/invoke` + 每会话 token；中间结果留在沙箱不进上下文，返回注记原文含 `N tool result(s) (~X tokens) stayed in the sandbox`（`:82156` 附近）。详见 19/20 篇。
> - **子代理 TaskManager 持久化可 resume**：任务从纯内存改为落盘 `~/.config/alma/tasks/tasks.json` + `logs/<taskId>.jsonl`（`:25868`），进程重启时僵尸任务标 `completed` 并可 `autoResumeInterruptedSubagents` 自动续跑（`:94777`）；REST 侧 `POST /api/agents/tasks/:taskId/resume` → `resumeSubagentTaskById`（`:94522`，取末尾 ≤40 条/≤20000 字符历史重建 prompt）。DB 侧另有 `agent_runs` 表（`:908` drizzle 定义，`:2757` SQL 原文）支撑 harness/sprint 结构化交接。详见 20 篇。
>
> 另：本篇 §6.1 的 prompt 组装顺序在 v0.0.990 扩展出 SECURITY.md 覆盖层、emotions/fatigue/travel/selfie/people 五个拟人化段、`<available_skills>`/notification_protocol/deep_links/managed_agent_catalog 四个协议段，anthropic 系还在 `SYSTEM INFO` 行处把 system 切成两条做 prompt cache（`:90462-90488`）——新顺序见 20 篇。

---

## 1. 模型适配层（Provider 抽象 / 配置结构 / 流式管线）

### 1.1 AI SDK 选型：Vercel AI SDK v5

【实证】`package.json` 依赖含 `ai` 与多个 `@ai-sdk/*` provider 包；bundle 里命中 `streamText`、`toUIMessageStreamResponse`、`text-delta`、`reasoning-delta`、`tool-input-streaming`、`tool-call`、`tool-result`、`finish`、`error` 等 AI SDK 标准 chunk 类型。

【实证】消息持久化格式 = AI SDK v5 `UIMessage`（top keys `[id, role, parts]`，parts 类型含 `text` / `reasoning` / `step-start` / `tool-<NAME>` / `file`），与 SDK 内存对象一一对应，前端可直接 `useChat` 消费。

> 结论：Alma **没有自造 provider 抽象层**，而是直接用 Vercel AI SDK 的统一 `LanguageModel` 接口，自己只负责"配置存取 + 密钥管理 + 路由到对应 `@ai-sdk/<provider>` 包"。

### 1.2 Provider 配置结构（SQLite `providers` 表）

【实证】

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,         -- 用户起的别名，如 "公司 OpenAI"
  type TEXT NOT NULL,         -- "openai" | "anthropic" | "google" | "azure" | "ollama" | ...
  api_key TEXT NOT NULL,      -- 加密存储，API 不出明文
  models TEXT NOT NULL DEFAULT '[]',  -- JSON 数组：该 provider 启用的 model id 列表
  base_url TEXT,              -- 自托管/代理时用
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

配套路由（REST）：

```
GET  /api/providers         POST /api/providers
PUT  /api/providers/:id     DELETE /api/providers/:id
POST /api/providers/:id/test      # 一键测活
GET  /api/models                  # 聚合所有 enabled provider 的可用模型
```

### 1.3 多模型槽位

【实证】`GET /api/settings` 返回 27 个顶层键，其中与模型相关的有：

- `chat`（主对话模型）
- `toolModel`（工具/agent 用的次级模型——**用于廉价模型跑工具循环、重型模型留给主对话**）
- `visionModel`（图像理解）
- `embeddingModel`（本地 embedding，transformers.js 缓存到 `~/Library/Application Support/alma/embedding-models/`）
- `whisper`（语音）
- `imageGen`（图片生成）
- `skillExtraction`（skill 自动抽取）

> 这是 Alma 一个很重要的设计：**不是一个模型走天下，而是按用途分槽**。复刻时至少要有 `chat` + `toolModel` 两档，成本能省 5-10 倍。

### 1.4 流式管线如何接到 WS

【实证】WS 端点 `/ws/threads`，帧类型含 `message_added`、`stream_chunk`、`step_start`、`tool_call`、`tool_result`、`generation_finished` 等。

【推测 + 强证据】管线几乎一定是这样：

```
POST message
  ├─→ 落库 user UIMessage
  ├─→ streamText({ model, messages, tools, stopWhen, ... })
  │      │
  │      ├─→ onChunk: { text-delta | reasoning-delta | tool-input-* | tool-call | tool-result }
  │      │       └─→ 原样 ws.broadcast(threadId, chunk)   ← 不改造 SDK chunk，直接转发
  │      │
  │      └─→ onFinish: { message, usage, finishReason }
  │              ├─→ INSERT chat_messages (message = JSON.stringify(UIMessage))
  │              └─→ INSERT usage_records (tokens, cost, model)
  └─→ ws.broadcast(threadId, {type:"message_added"})
```

【实证】bundle 事件名与 AI SDK chunk 类型**逐一对齐**，说明 Alma **直接转发 SDK 流，不做中间表示**。这是复刻时最该照抄的一点——**千万别自己造 chunk 协议**。

### 1.5 Abort / 中断

【实证】WS 客户端可发 `{type:"stop_generation", threadId}`；服务端调 `AbortController.abort()`。`chat_threads.is_generating` 标志位 + `parent_id/slot_id/depth` 版本树共同支持断线重连与重生成。

---

## 2. Agent Loop 与工具系统

### 2.1 Agent loop = AI SDK 的 `stopWhen` / `maxSteps`

【推测-高置信】Alma 没有手写 agent loop，而是直接用 AI SDK v5 的 `streamText({ stopWhen, ... })`：

- v5 推荐 `stopWhen: [stepCountIs(N), hasToolCall('finish'), ...]`，旧写法 `maxSteps: N` 也兼容。
- 每个 step 产出一个 `step-start` part（消息 parts 里实证存在）。
- 工具执行结果自动 append 为下一条 `tool` role message，loop 继续，直到 `stopWhen` 命中或模型不再发起 tool call。

【实证】messages 表 parts 数组里能数出 `step-start` 的个数 = agent 跑的步数。

### 2.2 内置工具清单（从消息 part 类型反推）

【实证】grep 大量线程后，消息 parts 里出现过的 `tool-<NAME>` 至少包括：

| 类别     | 工具名                                                               |
| -------- | -------------------------------------------------------------------- |
| 文件     | `Read` / `Write` / `Edit` / `Glob` / `Grep` / `MultiEdit`            |
| 执行     | `Bash`（含 `run_in_background`）/ `BashOutput`                       |
| 网络     | `WebFetch` / `WebSearch`                                             |
| 任务编排 | `Task`（子代理）/ `TodoWrite` / `TodoRead`                           |
| 浏览器   | `Browser*`（computer-use 系列，~25 条 `/api/computer-use/...` 路由） |
| 桌面     | `ComputerUse*`（click/type/scroll/shot/snap/launch_app）             |
| MCP      | `mcp__<server>__<tool>`（动态前缀）                                  |
| 元       | `Skill`（调用 skill）、`SendFile`（把产物发给用户）                  |

工具定义方式：【推测-高置信】每个工具就是一个 AI SDK `tool({ description, parameters: zodSchema, execute })` 对象，集中在 `tools/` 目录导出成 `Record<string, Tool>`，喂给 `streamText({ tools })`。

### 2.3 Tool-overflow：超长工具输出的兜底

【实证】`~/.config/alma/tool-overflow/Bash-stdout-*.log`、`Grep-rawOutput-*.log` 实测存在。机制：

1. 工具 `execute()` 返回前，先判断输出字节数/行数；
2. 超过阈值（估算 ~4KB 或 2000 行）→ 截断 + 落盘到 `~/.config/alma/tool-overflow/<Tool>-<field>-<hash>.log`；
3. 真正返回给模型的是 `[截断片段] + "full output saved to <path>; read it with Read offset/limit or grep/sed instead of re-fetching"`。

> 这是 Alma 解决"工具结果爆 token"的核心手段。**复刻必做**。约 30 行代码就能实现，但收益巨大。

---

## 3. 子代理 与 多 Agent 编排

### 3.1 Task 工具 + `subagent_type`

【实证】bundle 命中 `Task` 工具相关字符串、`subagent_type` 参数名、`/api/threads/:threadId/subagent-messages` 路由。

【推测-高置信】`Task` 工具签名大致是：

```ts
tool({
  description: 'Spawn a sub-agent to handle a sub-task',
  parameters: z.object({
    description: z.string(),
    prompt: z.string(),
    subagent_type: z.enum([
      'general-purpose',
      'explore',
      'plan',
      'researcher',
      'developer',
      'designer',
      'product-manager',
      'operator',
    ]),
  }),
  execute: async ({ prompt, subagent_type }) =>
    spawnAgent(subagent_type, prompt),
})
```

子代理内部又是一次完整 `streamText` loop，产出消息通过 `/api/threads/:threadId/subagent-messages` 暴露给前端，实现"主对话里点开看子代理全过程"的 UI。

### 3.2 Managed crew（受管专家团队）

【实证】bundle + 本对话 system prompt 都显示 Alma 有 `managed_agent_catalog`：`designer` / `product-manager` / `developer` / `researcher` / `operator` / `planner` / `evaluator`，每个角色有 `delegates to` 白名单（如 researcher 只能委派给 product-manager/designer/developer）。

【推测】实现 = 一张静态的 `agent_id → { systemPrompt, allowedDelegates, mode }` 注册表 + Task 工具在 `execute` 里查表、注入角色 system prompt、并以 `agent_id` 命名子线程。

### 3.3 Harness 模式痕迹

【实证】bundle 命中 `gan-style-harness`、`council`、`santa-method`、`ralphinho-rfc-pipeline` 等 skill 名，结合 `available_skills` 列表，说明 Alma 把 "Generator-Evaluator 对抗"、"多声音委员会"、"RFC 驱动 DAG" 等多 agent 编排模式**沉淀为可调用的 skill**（不是硬编码在主循环里）。

> 设计哲学：**主 agent loop 保持简单，复杂编排作为 skill 注入**。这是一个非常值得借鉴的决策——主循环稳定，编排逻辑可热插拔。

---

## 4. Skill / MCP / 插件 三大扩展机制对比

| 维度             | Skill                                                          | MCP                                                 | 插件 (plugins/)                              |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| **本质**         | 一个 `SKILL.md`（YAML frontmatter + Markdown 指令）            | 一个 MCP server（stdio 或 HTTP）                    | 一个前端 + 后端组合的扩展包                  |
| **存放**         | `~/.config/alma/skills/<name>/SKILL.md` 或内置 bundle          | `~/.config/alma/mcp.json`（或 DB `mcp_servers` 表） | `plugins/<name>/`（含 permissions/settings） |
| **谁调用**       | 主 agent 通过 `Skill` 工具按需加载                             | 主 agent 自动发现为 `mcp__<server>__<tool>`         | Electron 主进程 + 渲染进程同时挂载           |
| **渐进披露**     | ✅ 三级：metadata (name+desc) → SKILL.md 全文 → 附属文件按需读 | ✅ 工具列表先注册，schema 用时再拉                  | 部分（路由懒加载）                           |
| **能否新增工具** | 间接（通过指令让 agent 用现有工具组合）                        | ✅ 直接新增 namespaced 工具                         | ✅ 可新增 UI、API 路由、工具                 |
| **权限模型**     | 无（继承主 agent）                                             | OAuth token 表 `mcp_oauth_tokens`                   | 独立 `plugin_permissions` 表                 |
| **适用场景**     | 教 agent 新"做法"（流程/规范/模板）                            | 接外部 SaaS / 本地服务                              | 改 UI、加主题、加完整功能模块                |
| **WS 频道**      | `/ws/skills`（变更广播）                                       | `/ws/mcp-resources`（资源订阅）                     | —                                            |

【实证】SQLite 有 `skills` / `prompts` / `plugins` / `plugin_permissions` / `mcp_servers` / `mcp_oauth_tokens` 六张表，分别支撑这三套体系。

### 4.1 SKILL.md 渐进披露细节

【实证】frontmatter 字段至少含 `name` / `description` / `license` / `compatibility` / `metadata`。主 agent 启动时只把 `(name, description)` 列表注入 system prompt（见本对话的 `<available_skills>`）；agent 决定用哪个时，调 `Skill` 工具读全文；SKILL.md 里引用的其他文件（`reference.md` / `examples/`）再按需 Read。

> **三级披露 = 控制 context 占用的关键**。复刻时务必照抄，否则几百个 skill 一次灌进去 context 直接爆。

---

## 5. 权限与审批

### 5.1 危险工具审批流

【实证】

- `/api/computer-use/.../approvals` / `.../permissions` / `.../grant` / `.../check_approval` 等 ~25 条路由
- `settings.security.autoApproveToolRequests` 布尔位
- `plugins/:id/permissions` 路由 + `plugin_permissions` 表

【推测-高置信】审批流程：

```
agent 发起 tool call
   ↓
工具被标记为 dangerous？（Bash 写命令、Write、Edit、computer-use、插件工具……）
   ↓
是 → 查 autoApproveToolRequests
        ├─ true  → 直接执行
        └─ false → WS 推送 approval_request 给前端
                     ↓
                   用户在 UI 点 [允许/拒绝/始终允许]
                     ↓
                   后端写 approvals 记录 → 继续/中断 agent loop
```

### 5.2 绑定 loopback 的"裸奔"边界

【实证】所有 REST 端点对 `127.0.0.1` 无 token；只有 `chrome-relay` / `mobile-relay` 这类跨设备面有 `chromeRelayAuthToken` 等局部 token。

> Alma 的信任模型 = "**本机进程 = 自己人**"。审批只防"AI 乱来"，不防"本机其他进程乱来"。复刻若要远程暴露必须自加 token 中间件。

---

## 6. Prompt 组装 与 上下文管理

### 6.1 System Prompt 组成顺序

【实证 + 推测】以当前对话为例，system prompt 大致按以下顺序拼接：

```
1. 基础身份 + 工具使用规则 + 安全准则            （静态）
2. <managed_agent_profile>    当前 managed 角色    （动态）
3. <managed_agent_catalog>    可委派角色清单       （动态）
4. <available_skills>         skill 元数据列表     （动态，渐进披露一级）
5. 环境信息（cwd / OS / 日期）                    （动态）
6. 工作区文件快照（CLAUDE.md / AGENTS.md / 用户 memory）
7. 用户级自定义指令                               （来自 app_settings）
```

### 6.2 Compact / 压缩机制

【实证】

- 路由 `POST /api/threads/:id/compact`
- `chat_threads.tools_compact_view` 标志位（UI 层"工具紧凑展示"）
- 路由 `GET /api/threads/:threadId/context-usage`（查当前 token 用量）

【推测-高置信】compact 触发与执行：

1. **手动**：前端按钮 → `POST /:id/compact`
2. **自动**（推测）：`context-usage` 超阈值时，agent 收到提醒或自动触发
3. 实现 = 起一个次级 LLM 调用（用 `toolModel` 便宜模型），输入当前消息列表，输出"摘要 + 保留最近 N 条"，然后在 DB 里插入一条 role=system 的 compact 消息，旧消息标记 archived 不删。

【实证】tool-overflow（§2.3）是**另一条**上下文防线——compact 管"总长度"，overflow 管"单条过长"。两者叠加才让 134 步分析这种长会话可行。

---

## 7. 【复刻要点】最小 Agent 内核代码骨架

简化 TS 伪代码，~150 行可跑：

```ts
// ========== 1. Provider 适配 ==========
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'

function resolveModel(db, slotKey: 'chat' | 'toolModel') {
  const settings = getSettings(db)
  const { providerId, modelId } = settings[slotKey]
  const p = db.prepare('SELECT * FROM providers WHERE id=?').get(providerId)
  const apiKey = decrypt(p.api_key)
  const factory = { openai: createOpenAI, anthropic: createAnthropic }[p.type]
  return factory({ apiKey, baseURL: p.base_url })(modelId)
}
```

```ts
// ========== 2. 工具定义（含 tool-overflow）==========
import { tool } from 'ai'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const OVERFLOW_DIR = path.join(os.homedir(), '.config/alma/tool-overflow')
const OVERFLOW_LIMIT = 4000
fs.mkdirSync(OVERFLOW_DIR, { recursive: true })

function maybeOverflow(toolName: string, field: string, text: string): string {
  if (text.length <= OVERFLOW_LIMIT) return text
  const file = path.join(OVERFLOW_DIR, `${toolName}-${field}-${Date.now()}.log`)
  fs.writeFileSync(file, text)
  return (
    text.slice(0, OVERFLOW_LIMIT) +
    `\n...[truncated, full output saved to ${file}; read with Read offset/limit or grep]`
  )
}

const bashTool = tool({
  description: 'Run a bash command',
  parameters: z.object({
    command: z.string(),
    run_in_background: z.boolean().optional(),
  }),
  execute: async ({ command }) => {
    const out = await execBash(command) // 你自己的实现
    return maybeOverflow('Bash', 'stdout', out)
  },
})

const readTool = tool({
  description: 'Read file with offset/limit',
  parameters: z.object({
    file_path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  execute: async ({ file_path, offset = 1, limit = 2000 }) =>
    maybeOverflow('Read', 'content', readSlice(file_path, offset, limit)),
})

// ... Write / Edit / Glob / Grep / WebFetch / Task 同理
const builtinTools = { Bash: bashTool, Read: readTool /* ... */ }
```

```ts
// ========== 3. 子代理（Task 工具）==========
const AGENT_REGISTRY = {
  'general-purpose': { system: 'You are a general agent.', delegates: [] },
  researcher: {
    system: 'You are the researcher.',
    delegates: ['developer', 'product-manager', 'designer'],
  },
  developer: {
    system: 'You are the developer.',
    delegates: ['researcher', 'operator'],
  },
  // ...
}

const taskTool = (parentCtx) =>
  tool({
    description: 'Spawn a sub-agent',
    parameters: z.object({
      description: z.string(),
      prompt: z.string(),
      subagent_type: z.enum(
        Object.keys(AGENT_REGISTRY) as [string, ...string[]],
      ),
    }),
    execute: async ({ prompt, subagent_type }) => {
      // 白名单校验：当前角色允许委派给谁
      if (!AGENT_REGISTRY[parentCtx.role].delegates.includes(subagent_type))
        return `Error: ${parentCtx.role} cannot delegate to ${subagent_type}`
      return runAgent({
        // 递归调本节 §7 的 runAgent
        role: subagent_type,
        system: AGENT_REGISTRY[subagent_type].system,
        userPrompt: prompt,
        threadId: parentCtx.threadId, // 子线程挂在主线程下，供 /subagent-messages 拉取
        depth: parentCtx.depth + 1,
      })
    },
  })
```

```ts
// ========== 4. 主 agent loop ==========
import { streamText, stepCountIs } from 'ai'

async function runAgent(opts: {
  role: string
  system: string
  userPrompt: string
  threadId: string
  depth: number
}) {
  const db = getDb()
  const model = resolveModel(db, opts.depth === 0 ? 'chat' : 'toolModel') // 子代理用便宜模型
  const messages = loadHistory(db, opts.threadId) // UIMessage[]
  messages.push({
    id: nanoid(),
    role: 'user',
    parts: [{ type: 'text', text: opts.userPrompt }],
  })
  saveMessage(db, opts.threadId, messages.at(-1))

  const systemPrompt = assembleSystemPrompt({
    base: BASE_PROMPT,
    role: opts.system,
    catalog: AGENT_REGISTRY, // <managed_agent_catalog>
    skills: listSkillMetadata(db), // <available_skills> 只 (name, desc)
    env: { cwd: process.cwd(), os: process.platform, date: new Date() },
    workspaceDocs: readIfExists(['CLAUDE.md', 'AGENTS.md']),
    userPrefs: getSettings(db).customInstructions,
  })

  const tools = {
    ...builtinTools,
    Task: taskTool({
      role: opts.role,
      threadId: opts.threadId,
      depth: opts.depth,
    }),
    ...(await loadMcpTools(db)), // mcp__<server>__<tool>
    ...(await loadPluginTools(db)),
  }

  const abort = new AbortController()
  registerAbortHandle(opts.threadId, abort) // 供 /ws stop_generation 调

  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: [stepCountIs(150)], // 替代旧 maxSteps
    abortSignal: abort.signal,

    onChunk: async ({ chunk }) => {
      // 原样转发 AI SDK chunk —— 不改造，前端 useChat 直接消费
      wsBroadcast(opts.threadId, { type: 'stream_chunk', chunk })
    },

    onFinish: async ({ response, usage, finishReason }) => {
      const assistantMsg = {
        id: nanoid(),
        role: 'assistant',
        parts: response.messages.at(-1).parts,
      }
      saveMessage(db, opts.threadId, assistantMsg)
      recordUsage(db, {
        threadId: opts.threadId,
        model: model.modelId,
        usage,
        finishReason,
      })
      wsBroadcast(opts.threadId, {
        type: 'message_added',
        message: assistantMsg,
      })
      wsBroadcast(opts.threadId, { type: 'generation_finished' })
    },

    onError: async ({ error }) => {
      wsBroadcast(opts.threadId, { type: 'error', error: String(error) })
    },
  })

  await result.consumeStream()
  return (await result.text) ?? ''
}
```

```ts
// ========== 5. 审批闸门（包在工具外层）==========
const DANGEROUS = new Set([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'ComputerUse*',
])

function withApproval(t: Tool, name: string, db): Tool {
  if (!DANGEROUS.has(name)) return t
  return {
    ...t,
    execute: async (args, ctx) => {
      if (getSettings(db).security.autoApproveToolRequests)
        return t.execute(args, ctx)
      const ok = await askUserApproval({ tool: name, args }) // WS → 前端弹窗
      if (!ok) throw new Error('User denied')
      db.prepare(
        'INSERT INTO approvals(tool,args,granted_at) VALUES(?,?,?)',
      ).run(name, JSON.stringify(args), Date.now())
      return t.execute(args, ctx)
    },
  }
}
```

```ts
// ========== 6. Compact（压缩）==========
async function compactThread(threadId: string) {
  const db = getDb()
  const msgs = loadHistory(db, threadId)
  const toolModel = resolveModel(db, 'toolModel') // 用便宜模型做摘要
  const summary = await generateText({
    model: toolModel,
    prompt: `Summarize the following conversation, keep key facts/decisions/todos:\n\n${JSON.stringify(msgs)}`,
  })
  // 插一条 system compact 消息，旧消息标记 archived（不删，留审计）
  db.prepare('UPDATE chat_messages SET archived=1 WHERE thread_id=?').run(
    threadId,
  )
  saveMessage(db, threadId, {
    id: nanoid(),
    role: 'system',
    parts: [{ type: 'text', text: `[Compacted summary]\n${summary.text}` }],
  })
}
```

---

## 复刻优先级（按性价比排序）

| #   | 必做                                                          | 收益                                  |
| --- | ------------------------------------------------------------- | ------------------------------------- |
| 1   | 直接用 Vercel AI SDK + `toUIMessageStreamResponse` chunk 协议 | 省自己造协议，前端 `useChat` 开箱即用 |
| 2   | `tool-overflow`（30 行代码）                                  | 单条工具输出再也不会爆 context        |
| 3   | 多模型槽位（至少 `chat` + `toolModel`）                       | 成本降 5-10x                          |
| 4   | 消息整存 JSON（UIMessage 序列化进 `message TEXT`）            | 读写零转换                            |
| 5   | `stopWhen: stepCountIs(N)` 替代手写 loop                      | agent loop 稳定可靠                   |
| 6   | SKILL.md 三级渐进披露                                         | context 占用降一个数量级              |
| 7   | 危险工具审批闸门（一个高阶函数）                              | 安全兜底                              |
| 8   | Compact 摘要 + `parent_id/slot_id/depth` 版本树               | 长会话可行 + 重新生成                 |

---

## 附录：与既有文档的衔接

- 后端 schema / WS 协议 / REST 路由细节 → 见 `03-backend-api-database.md`
- Electron 桌面壳与 IPC → 见 `02-electron-desktop.md`
- 复刻路线图 → 见 `06-replication-roadmap.md`

【全文完】

---

## 8. 全流程代码走读：从 POST 到落库（bundle 逆向版）

> 范围：把"用户按回车"到"消息落库"中间每一步的 **minified 代码实锤**串起来。
> 证据基础：对 `/tmp/alma-src/extracted/out/main/index.js`（2.3MB minified）的 grep + 上下文截取。
> 标注规则同前文：【实证】= bundle 命中原始字符串/字段；【推测】= 没找到直接证据，按 AI SDK 通行做法还原。

### 8.1 入口：**不是 REST POST，是 WS `generate_response` 消息**

**【关键反直觉实证】** 翻遍 bundle 找不到 `.post("/api/threads/:threadId/messages"`。Alma 的"发消息"**完全走 WebSocket**，REST 端只剩 GET / 管理类操作。REST 路由表里 message 相关的只有：

- `GET /api/threads/:threadId/messages`（读历史）
- `POST /api/messages/:messageId/rollback` / `switch-version`（版本树操作）
- `POST /api/threads/:threadId/inject-test-message`（调试用）
- `POST /api/threads/:threadId/send-photo`（图片附件单独走 HTTP multipart）

**真实入口在 `setupWebSocket()` 里**，WS 路径 `/ws/threads`，消息分发代码还原如下（minified 变量名 `e/t/n/o/r/s/i/a/c/l/d/u/h/p/m/f/g` 保留，对应实参可见）：

```js
// bundle offset ~1860300
setupWebSocket(){
  this.server && (this.wss = new sn({server:this.server}),
  this.wss.on("connection", (e, t) => {
    const n = new URL(t.url||"", `http://${t.headers.host}`);
    const o = n.pathname;
    if ("/ws/threads" === o) {
      this.threadSyncClients.add(e);          // ← 所有 thread 共享一个 WS channel
      console.log("Thread sync client connected");
      // 连上立刻推一次"正在生成"快照，让客户端恢复 spinner 状态
      try {
        e.send(JSON.stringify({
          type: "generating_snapshot",
          data: { ids: Array.from(this.activeGenerations.keys()) }
        }));
      } catch(r) { console.error("Failed to send generating_snapshot:", r) }

      e.on("message", async t => {
        try {
          const o = JSON.parse(t.toString());
          // 【实锤】两个入口 type：generate_response 和 steer_generation
          if ("generate_response" === o.type || "steer_generation" === o.type) {
            const {
              threadId: t, userMessage: r,
              retryOfMessageId: s, replaceMessageId: i,   // 版本树/重生成
              tools: a,                                    // 客户端可临时指定工具子集
              reasoningEffort: c,
              enabledMCPServerIds: l,                      // MCP 服务器白名单
              source: d, noTools: u,
              ephemeralModel: h,                           // 一次性模型覆盖
              userMessageMetadata: p,
              ephemeralContext: m,                         // 一次性 system prompt 附加
              fromQuickChat: f, hummingbirdContext: g
            } = o.data;

            // 【实锤】"生成中" 拦截 + 转向（steering）
            const n = { hasUserMessage: !!r, retryOfMessageId: s, replaceMessageId: i };
            if (n.hasUserMessage && !n.retryOfMessageId && !n.replaceMessageId) {
              const e = this.activeGenerations.get(t);
              const n = !!e && this.bgResumeControllers.has(e);
              if (("steer_generation" === o.type || !n) && this.steerActiveGeneration(t, r, p))
                return;   // 当前还在生成 → 把这条消息作为"转向指令"喂给跑着的 loop
              if ("steer_generation" === o.type)
                console.log(`[Steering] thread ${t} not generating — falling back to a normal turn`);
            }

            // 模型解析：客户端没指定 → 查 thread 上次用的 model → 落到 settings.chat.defaultModel
            let y = o.data.model;
            if (!y) {
              const e = or.getThreadById(t);
              y = e?.model || (() => {
                const e = or.getSettings();
                const t = e ? JSON.parse(e.settingsData) : {};
                return t?.chat?.defaultModel;
              })();
            }
            // 模型 id 可能没带 provider 前缀（"gpt-4o"），要补全成 "openai:gpt-4o"
            if (y && !y.includes(":")) {
              const e = this.resolveUnprefixedModel(y);
              e && (console.log(`[WS] Resolved unprefixed model "${y}" → "${e}"`), y = e);
            }

            // 【实锤】所有参数汇聚到 generateChatResponse
            await this.generateChatResponse(t, y, r, {
              retryOfMessageId: s, replaceMessageId: i, toolKeys: a,
              reasoningEffort: c, enabledMCPServerIds: l,
              sourceClient: e, source: d, noTools: u,
              ephemeralModel: h, userMessageMetadata: p,
              ephemeralContext: m, fromQuickChat: f, hummingbirdContext: g
            });
          }
          else if ("stop_generation" === o.type) {
            const { threadId: e } = o.data;
            this.stopGeneration(e);
          }
        } catch(o) {
          console.error("WebSocket message error:", o);
          e.send(JSON.stringify({
            type: "error",
            data: { error: o instanceof Error ? o.message : String(o) },
            timestamp: new Date().toISOString()
          }));
        }
      });
      e.on("close", () => {
        this.threadSyncClients.delete(e);
        console.log("Thread sync client disconnected");
      });
    }
    // else if "/ws/settings" → 另一个 channel，管主题预览等
  }));
}
```

**关键证据点**：

- 搜索关键词：`"generate_response"` / `"steer_generation"` / `"stop_generation"` / `"generating_snapshot"` / `threadSyncClients` / `activeGenerations` / `generateChatResponse`
- **没有 zod schema 校验**：bundle 里 `z.object(` 出现 0 次。WS payload 直接 `JSON.parse` + 解构，靠 TypeScript 类型在编译期保证（运行时裸奔）。
- **没有 user message 落库代码在这段**：落库发生在 `generateChatResponse` 里（见 §8.2）。
- **`activeGenerations: Map<threadId, generationHandle>`** 是全局生成状态登记处，断线重连时通过 `generating_snapshot` 一次性同步给新连上的客户端。
- **`steer_generation` 是 Alma 独有设计**：如果当前 thread 正在生成，新消息不打断、而是"注入"到跑着的 loop 里改变方向；只有 `steerActiveGeneration()` 返回 false（loop 不在跑或跑完了）才落回正常 turn。

**设计意图**：用 WS 而不是 REST 是因为：

1. 流式输出本来就要走 WS 推，请求-响应和流推用一个 channel 简化状态同步；
2. `steer_generation` 这种"打到正在跑的 loop 里"的语义用 REST 很难表达；
3. `generating_snapshot` 推送给所有客户端，天然支持多窗口/多设备同步（Mac 主窗口 + iPad companion 都能看到"正在生成"）。

### 8.2 上下文组装：system prompt 拼接 + 历史消息转 AI SDK messages

#### 8.2.1 历史消息：UIMessage JSON **直接用，零转换**【实证】

先看消息持久化的真实形态。`chat_messages` 表 schema（bundle offset ~55155 起）：

```sql
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    parent_id TEXT,              -- 版本树父指针
    slot_id TEXT,                -- 版本槽位（重新生成时挂同一 slot）
    depth INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL,       -- ★ 整包 UIMessage JSON 字符串
    timestamp TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
);
```

读出来后**就是 JSON.parse 一下**，然后 `.parts` 直接用。bundle 里的证据（`runGoalEvaluation` 里的一段，offset ~1871300）：

```js
// 读最近 12 条 → JSON.parse message 字段 → 提 parts
;(or.getThreadWithMessages(e)?.messages ?? []).slice(-12).map((e) => {
  const t = 'string' == typeof e.message ? JSON.parse(e.message) : e.message
  const n = (t?.parts ?? [])
    .filter((e) => 'text' === e?.type || 'tool-result' === e?.type)
    .map((e) =>
      'string' == typeof e.text
        ? e.text
        : JSON.stringify(e.output ?? '').slice(0, 500),
    )
    .join('\n')
  return { role: String(t?.role ?? 'assistant'), text: n }
})
```

另一个证据：`extractTextFromUIMessage(e){ return e.parts ? e.parts.filter(...)}`（offset ~1875800）—— 函数名直接叫"从 UIMessage 抽文本"，证实 DB 里存的就是 AI SDK v5 `UIMessage` 对象。

> **设计意图**：选 UIMessage 作为磁盘格式 = 选 AI SDK 作为协议的"source of truth"。读写零转换、前端 `useChat` 零适配、流式 chunk 原样落盘。**这是 Alma 最省代码的决策之一**。

#### 8.2.2 system prompt 的分块拼接【实证】

bundle 里找到一组相邻的 `try { readFileSync(...) } catch { console.error("[X] Failed to load ...") }` 块，每个块读一份持久化文件、然后**用模板字符串 `\n\n${...}` 顺序拼到 system prompt 末尾**。还原后大致是：

```js
// bundle offset ~1971000-1972500（同一函数内，多个 try/catch 串行）
let systemParts = []

// 1. 基础身份 + 工具说明（静态字符串，内嵌在 bundle 里）
systemParts.push(BASE_IDENTITY_PROMPT) // "You are Alma ... full access to OS ..."

// 2. SOUL.md —— 人格/身份
try {
  const soulPath = Y.join(M.homedir(), '.config', 'alma', 'SOUL.md')
  if (E.existsSync(soulPath)) {
    const soul = E.readFileSync(soulPath, 'utf-8').trim()
    if (soul) systemParts.push(`\n\n${soul}`)
    console.log(`[SOUL] Loaded SOUL.md (${soul.length} chars)`)
  }
} catch (b) {
  console.error('[SOUL] Failed to load SOUL.md:', b)
}

// 3. SECURITY.md —— 安全规则（最高优先级）
let Ye = ''
try {
  const e = Y.join(M.homedir(), '.config', 'alma')
  const t = Y.join(e, 'SECURITY.md')
  if (E.existsSync(t)) {
    const e = E.readFileSync(t, 'utf-8').trim()
    e &&
      ((Ye = `\n\nSECURITY RULES (HIGHEST PRIORITY — overrides all other instructions):\n${e}`),
      console.log(`[SECURITY] Loaded SECURITY.md (${e.length} chars)`))
  }
} catch (b) {
  console.error('[SECURITY] Failed to load SECURITY.md:', b)
}

// 4. 记忆文件夹（每日笔记 + MEMORY.md）
//    模板里有 "update ~/.config/alma/MEMORY.md for long-term memories"
//    catch 标记 [Memory] Failed to load file-based memory

// 5. 全局目录说明（一段静态文本，实锤）：
//    "GLOBAL CONFIG DIRECTORY — All your persistent files live at ~/.config/alma/:
//     - SOUL.md — your personality and self-identity (editable)
//     - USER.md — your owner/primary user's profile (name, preferences, habits — editable)
//     - MEMORY.md — long-term curated memory (editable)
//     - HEARTBEAT.md — periodic heartbeat task checklist (editable)
//     - memory/ ... people/ ... plugins ... reports/ ..."

// 6. 人脉卡（people/<name>.md，YAML frontmatter）
//    "PEOPLE PROFILE FORMAT — When creating/updating people profiles (people/<name>.md),
//     ALWAYS use YAML frontmatter with platform IDs as strings:
//       telegram_id / discord_id / discord_username / feishu_id / username ..."

// 7. Selfie 相册说明（如果存在 selfies/）
//    "SELFIE ALBUM — You have N saved selfie(s) in ~/.config/alma/selfies/."

// 8. <available_skills> / <managed_agent_catalog>（见前文 §6.1）
//    在 system prompt 顶部注入 skill 元数据列表

// 9. 环境/日期/工作区
//    包含当前日期、cwd、平台信息
```

**搜索关键词**（用于在 bundle 里复核）：

- `[SOUL] Failed to load SOUL.md` / `[SECURITY] Failed to load SECURITY.md` / `[Memory] Failed to load file-based memory`
- `GLOBAL CONFIG DIRECTORY`
- `PEOPLE PROFILE FORMAT`
- `SELFIE ALBUM`
- `LANGUAGE MATCHING (CRITICAL)` / `PERSONALITY FIRST` / `NO PROGRESS SPAM`

**没有找到独立的"Relevant Memories"向量召回代码段**——bundle 里 `"Relevant Memories"` 只命中 1 次（offset 1994707），且周围没有 embedding/向量搜索调用。说明 Alma 的"相关记忆"实际是**靠 MEMORY.md 全文 + memory/ 目录由 agent 用 Read 工具按需取**，不是 RAG。

> **设计意图**：
>
> 1. **文件即记忆**：把 memory/persona/security 都写成 `~/.config/alma/*.md` 明文 Markdown，agent 和用户都能直接改；启动时一次性读入拼到 system prompt 尾部，运行时 agent 也可以用 Read 工具再看。
> 2. **顺序即优先级**：SECURITY.md 被标注"HIGHEST PRIORITY"，放在 SOUL.md 之后但其他规则之前，利用 LLM 的"越晚出现权重越高"特性。
> 3. **失败降级**：每段都套 `try/catch + console.error`，文件缺失不影响主流程，只少一段 prompt。

### 8.3 模型解析：providers 表 → apiKey 解密 → 槽位选模型 → provider factory

#### 8.3.1 ORM 是 **Drizzle**【实证】

bundle 里能看到 Drizzle 的 column builder 写法：

```js
// bundle offset ~60000 附近
providers: pgTable("providers", {
  id: he("id").primaryKey(),
  name: he("name").notNull(),
  type: he("type").notNull(),
  availableModels: he("available_models", { mode: "json" }).$type().notNull().default([]),
  apiKey: he("api_key").notNull(),              // ← 属性名 camelCase / 列名 snake_case
  baseURL: he("base_url"),
  apiVersion: he("api_version"),
  isResponseAPI: pe("is_response_api", { mode: "boolean" }).default(!1),
  useMaxCompletionTokens: pe("use_max_completion_tokens", { mode: "boolean" }).default(!1),
  customHeaders: he("custom_headers"),
  apiFormat: he("api_format", { enum: ["openai-chat", ...] }),
  // ...
})
```

所以前面 §1.2 的 schema 其实**少了 `available_models` / `is_response_api` / `use_max_completion_tokens` / `custom_headers` / `api_format` 五列**——LLM 推测经常漏字段，以 bundle 为准。

**schema 里没出现的字段说明 Alma 用 SQLite TEXT/JSON 列存灵活数据，通过 Drizzle `$type()` 在 TS 层定型**，不需要 schema 迁移。

#### 8.3.2 apiKey 加密 = Electron `safeStorage`【实证】

bundle 里出现一组关键 API：

```js
// bundle offset ~405553
if (u.isEncryptionAvailable()) {
  t = u.decryptString(Buffer.from(e));   // 解密
} else {
  t = e.toString("utf8");                 // 降级明文
}

// 保存侧（offset ~405900）
async saveAccountToken(e, t) {
  await this.ensureAccountsDir();
  const n = this.getAccountTokenPath(e);
  if (!u.isEncryptionAvailable())
    return void(await E.promises.writeFile(n, t, "utf8"));   // 明文降级
  const o = u.encryptString(t);                              // ★ 加密
  await E.promises.writeFile(n, o);
}
```

`u.encryptString` / `u.decryptString` / `u.isEncryptionAvailable` 三个名字是 **Electron `safeStorage` 模块的标准 API**，不是自实现的 AES：

- macOS → 用 Keychain 派生密钥加密
- Windows → DPAPI
- Linux → libsecret / kwallet，**没装就 `isEncryptionAvailable() === false`，降级明文**

> 上面这段是 **Copilot 账号 token 的加密**，不是 providers.api_key。providers.api_key 的加解密代码在 bundle 里**没有找到独立的 `decrypt(apiKey)` 调用**——意味着两种情况之一：
>
> 1. `providers.api_key` 也是走 `safeStorage`（在 `getProviderByIdFromDatabaseOnly` 内部解密），grep 没找到是因为函数被 inline 了；
> 2. **providers.api_key 在 DB 里就是明文**，靠 macOS 文件权限保护（`~/Library/Application Support/alma/`）。
>
> 从代码风格看（Copilot 都显式调 safeStorage），更可能是 **(1)**，但**无法 100% 实证**。复刻时按 (1) 实现最安全。

#### 8.3.3 provider factory：14 个 switch case【实证】

bundle 里 `Lp`（导出名 `getAIModel`）的 switch 语句覆盖了 **14 个 provider type**：

```js
// 函数签名：function Lp(providerRow, modelId) → LanguageModel
// 下面是从 bundle 抠出的 case 清单（顺序即代码顺序）：

case "openai":              // → createOpenAI(...)
case "openai-compatible":   // → 同上 + baseURL 自定义
case "anthropic":           // → createAnthropic(...)
case "google":              // → createGoogleGenerativeAI(...)
case "azure":               // → createAzure(...)
case "deepseek":            // → createDeepSeek(...)
case "moonshot":            // → createMoonshot / OpenAI-compatible
case "openrouter":          // → createOpenRouter(...)
case "kimi-coding-plan":    // → 特化版 anthropic，baseURL=api.kimi.com/coding/v1
                            //    headers: { "anthropic-beta": "interleaved-thinking-2025-05-14,
                            //                fine-grained-tool-streaming-2025-05-14" }
case "opencode-go":         // → Mp({apiKey, baseURL, modelId, availableModels, fetch})
case "ollama":              // → baseURL 默认 http://localhost:11434/v1
                            //    apiKey 缺省给 "ollama"（Ollama 不校验但要占位）
case "volcengine":          // → 字节豆包，baseURL=https://ark.cn-beijing.volces.com/api/v3
case "copilot":             // → GitHub Copilot 账号体系（单独的 OAuth 流程）
case "custom":              // → 最灵活：支持 customHeaders / per-model customHeaders /
                            //    extraBody（JSON.parse 后 merge 进请求体）
                            //    还会从 customHeaders 里单独提取 user-agent
default:                    // OpenAI 兼容的兜底
  const e = Pt({apiKey:n.apiKey, baseURL:n.baseURL, fetch:zs(n.fetch), headers:n.headers});
  return n.useResponsesAPI ? e.responses(t) : e(t);
                            // ↑ OpenAI Responses API vs Chat Completions 的分叉
```

**关键导出表**（bundle 里 `Object.freeze(Object.defineProperty({...}, Symbol.toStringTag, {value:"Module"}))` 形态）：

```js
{
  getAIModel: Lp,                      // (providerRow, modelId) → LanguageModel
  getAIModelByProviderId: Bp,          // (providerId, modelId) → 先查 DB 再调 Lp
  getProviderTypeById: Up,             // (providerId) → "openai" | "anthropic" | ...
  getUnifiedProvider: jp,              // (providerId) → {id,type,enabled,models,isPlugin,dbProvider}
  isPluginProvider: Fp                 // (providerId) → boolean（区分插件 provider 和 DB provider）
}
```

调用链（在 `generateChatResponse` 里）：

```js
// 还原后
const model = await Bp(providerId, modelId) // getAIModelByProviderId
// 内部：
//   const p = databaseService.getProviderByIdFromDatabaseOnly(providerId);
//   if (!p || !p.enabled) return null;
//   return Lp(p, modelId);                   // 走 switch
```

#### 8.3.4 chat / toolModel 槽位分工【实证】

在 goal evaluation 的代码里看到一次**非常明确的分工证据**：

```js
// bundle offset ~1871300
const e = await Dh() // 读 settings
const n = e.model ? md(e.model) : null // e.model 是 "providerId:modelId" 形式
if (n) {
  const e = await Bp(n.providerId, n.modelId) // 用 toolModel 槽位去拿模型
  // ... 用这个便宜模型跑 goal evaluation / compact / title generation
}
```

`settings.model`（= toolModel 槽位）被用于 **goal evaluation、compact 摘要、title 生成** 这类"后台辅助任务"。主对话走 `settings.chat.defaultModel`。

> **设计意图**：
>
> 1. **provider type 用 switch 而不是策略注册表**：14 个硬编码 case 直来直去，没有"插件可新增 provider type"的抽象。要加新 provider 就改这个 switch——简单但封闭。
> 2. **OpenAI Responses API 是新分支**：`useResponsesAPI ? e.responses(t) : e(t)` 说明 Alma 同时支持 Chat Completions 和 Responses 两种 OpenAI 调用形态（Responses API 是 2025 新接口，支持 reasoning trace）。
> 3. **kimi-coding-plan 单独分支**：说明 Alma 跟 Kimi 有深度合作，走 Anthropic 协议但加了 Kimi 特有的 beta header（interleaved thinking + fine-grained tool streaming）——这是为 Claude-in-Kimi 模型铺路。

### 8.4 streamText 调用：tools / stopWhen / parallelToolCalls / AbortController

#### 8.4.1 `we = streamText` 的完整调用【实证，bundle offset ~2035800】

Alma 主 agent loop 是一个 **`for(;;)` 无限循环 + 每轮重新构造 streamText 参数** 的结构。每轮开头先定义两个 stop 条件函数，然后发起 streamText：

```js
// ====== bundle offset 2035000-2036400 还原 ======
// 外层 for(;;) 循环（变量 on 恒为 true，所以是死循环，靠 break/return 退出）
for (
  n = `${e}--${ln}`,
    this.inflightAssistantMessages.set(e, {
      messageStorageId: n,
      uiMessageId: ln,
    }),
    console.log(`[Tools Debug] modelId: ${k}`),
    console.log(`[Tools Debug] isGeminiTextModel: ${Dt}`),
    console.log(
      `[Tools Debug] initialActiveTools: ${le ? le.join(', ') : 'all tools'}`,
    );
  on; // ← on = true，死循环
) {
  // 【实锤】两个 stopWhen 条件，都是 closure
  const r = ({ steps: e }) => {
    const t = 100 + (en ? 1 : 0) // ★ 硬编码 100 步；en 是"有 steering 待注入"标志，给 101
    return e.length >= t
  }
  const s = () => (this.pendingSteeringMessages.get(e)?.length ?? 0) > 0
  // ↑ 有待注入的 steering 消息 → 立即停当前 loop

  const f = ce ? Object.keys(ce).length : 0

  // 【实锤】PM-011 不变量：工具数 > 40 且没显式 activeTools → 强制 fall back
  if (!le && f > 40 && !Gt) {
    uN(
      `[Tools] INVARIANT VIOLATION (PM-011): activeTools unset while catalog has ${f} tools
        — the AI SDK would ship ALL of them on the wire.
        Falling back to a minimal active set.`,
      { provider: A?.type, effectiveToolKeys: ie.length, catalogSize: f },
    )
    le = mN([], new Set(Object.keys(ce ?? {})), this.isPtcEnabled())
  }

  // 【实锤】streamText 参数（we = streamText）
  const w = {
    model: Wt,
    instructions: Pt, // ← system prompt（v5 新参数名，等价于 system:）
    messages: nn,
    allowSystemInMessages: !0,
    abortSignal: d.signal, // ← AbortController
    tools: ce,
    repairToolCall: yg, // ← 工具调用修复器（schema 不匹配时自动修复）
    ...(le ? { activeTools: le } : {}), // 显式工具白名单
    ...(Jt ? { maxOutputTokens: Jt } : {}),
    // 【实锤】三分支决定 maxSteps vs stopWhen
    ...(Gt
      ? { maxSteps: 1 } // ACP 模式：强制单步（外部 agent 协议）
      : Dt && ce && 'AttemptCompletion' in ce
        ? { stopWhen: [r, _e('AttemptCompletion'), s] } // 子代理模式：加 hasToolCall 停止
        : { stopWhen: [r, s] }), // 主对话：步数 + steering 两条件
    ...(Object.keys(Ot).length > 0 ? { providerOptions: Ot } : {}),
    onError: ({ error: e }) => {
      /* ... auto-continue 逻辑 ... */
    },
    // onChunk / onStepFinish 等回调在更后面（见 §8.5）
  }
  const result = we(w) // ← 发起 streamText
  // ... 处理 result，更新 nn (messages)，continue for(;;) 或 break
}
```

#### 8.4.2 关键参数清单【全部实证】

| 参数                    | 值 / 来源                                 | 含义                                                                                    |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `model`                 | `Wt = await this.getAIModel(A, k, {...})` | §8.3 解析好的 LanguageModel                                                             |
| `instructions`          | `Pt`                                      | system prompt（AI SDK v5 把 `system:` 改名为 `instructions:`）                          |
| `messages`              | `nn`                                      | 从 DB 读出的 UIMessage 数组（§8.2.1）                                                   |
| `allowSystemInMessages` | `true`                                    | 允许 messages 数组里再插 system role 消息（用于 compact 摘要注入）                      |
| `abortSignal`           | `d.signal`                                | 来自本线程专属的 AbortController                                                        |
| `tools`                 | `ce`                                      | 合并后的全部工具（内置 + MCP + 插件）                                                   |
| `activeTools`           | `le`（可选）                              | 本轮显式允许的工具白名单                                                                |
| `maxOutputTokens`       | `Jt`（可选）                              | 按 provider 类型查 `capabilities.maxOutputTokens`；anthropic/claude-subscription 显式设 |
| `stopWhen` / `maxSteps` | 见上面三分支                              | **100 步 / steering 挂起 / AttemptCompletion 工具被调** 三种停法                        |
| `repairToolCall`        | `yg`                                      | 工具调用 schema 校验失败时的自动修复函数                                                |
| `providerOptions`       | `Ot`                                      | provider 特有配置（如 anthropic 的 cacheControl）                                       |

#### 8.4.3 parallelToolCalls 闸门【实证】

`parallelToolCalls` 不是直接传给 streamText，而是传给 `getAIModel`（factory 层）：

```js
// bundle offset ~2035100
const Bt = 'openrouter' === A?.type && It && ce && Object.keys(ce).length > 0
//   ↑ openrouter 且要 parallel 且有工具
Wt = await this.getAIModel(A, k, {
  parallelToolCalls: !Bt && void 0, // ← Bt 为 true 时传 false 显式禁用；否则传 undefined 用默认
  withTools: jt,
  threadId: e,
  workspacePath: p || void 0,
})
```

在 `Lp`（factory）里这个值只被 **openrouter 分支**消费：

```js
case "openrouter":
  r = Kt({apiKey: t.apiKey, baseURL: t.baseURL || void 0, fetch: yO})(n, {
    parallelToolCalls: o?.parallelToolCalls   // ← 传给 openrouter provider 构造
  });
  break;
```

> **设计意图**：parallelToolCalls 是 **OpenRouter 特有参数**，用来防止某些开源模型对 parallel tool call 支持不好时出 bug。其他 provider 不传，用各自默认行为。

#### 8.4.4 AbortController：activeGenerations Map【实证】

每个 thread 的生成对应一个独立的 AbortController，登记在 `activeGenerations` 里：

```js
// 登记（在 generateChatResponse 开头附近）
const d = new AbortController();
this.activeGenerations.set(threadId, {
  abort: () => d.abort(),
  chatId: ...,              // telegram 等渠道用
  threadId,
  startedAt: Date.now()
});

// stopGeneration 函数（bundle offset ~1872400，实锤）
stopGeneration(e) {
  const t = this.activeGenerations.get(e);
  if (t) {
    t.abort();                                    // ★ 调 AbortController.abort()
    this.activeGenerations.delete(e);
    this.generationTimerResetRefs.delete(e);
    // ... 广播 generation_finished 事件给 WS
  }
}

// WS 收到 stop_generation 时（§8.1 那段）
else if ("stop_generation" === o.type) {
  const { threadId: e } = o.data;
  this.stopGeneration(e);   // ← 就这样找到对应 controller
}
```

streamText 拿到 `abortSignal` 后，内部在每轮 step / 每个 chunk 处理点都会检查 `signal.aborted`，触发后立刻 reject 并触发 `onAbort` 回调。

> **设计意图**：
>
> 1. **100 步硬编码上限**是 Alma 对"agent 跑飞"的最后兜底。对比 `ALMA_MAX_AUTO_CONTINUE=10`（防 auto-continue 跑飞）和 `sn=3`（重试上限），三层保险。
> 2. **steering 作为 stop 条件**是 Alma 的巧妙设计：当用户发了新消息且 thread 正在生成，不直接 abort，而是往 `pendingSteeringMessages` 塞一条；当前 step 结束 → `s()` 返回 true → loop 停 → 外层 for(;;) 把 steering 消息 append 进 messages → 再开新一轮 streamText。**用户感觉是"AI 听进去了"，实际是中断+重启**。
> 3. **PM-011 不变量**说明 Alma 团队被"工具太多爆 context"坑过，专门加了运行时自检。这个模式值得照抄。

### 8.5 流式分发：chunk → WS 广播

#### 8.5.1 事件名不是 `stream_chunk`，是 **`message_delta`**【实证】

Alma 的 WS 广播函数 `broadcastThreadSync(type, data)` 支持 35 种事件（grep `broadcastThreadSync\("[a-z_]+"` 全量命中）：

```
消息 CRUD     message_added / message_updated / message_deleted / message_rollback / message_delta
生成状态      thread_generating / generation_completed / generation_error
上下文        context_compacted / context_compaction_started / context_overflow_detected / context_usage_update
标题          title_generating / title_generated
线程          thread_created / thread_updated / thread_deleted / thread_workspace_set
工作区        workspace_created / workspace_updated / workspace_deleted
目标          goal_updated / loop_updated
计划          plan_update / todo_update
子代理/并行   ptc_inner_call / tool_group_summary
进度          memory_retrieval_progress / skill_analysis_progress / skill_extraction_progress /
              tool_analysis_progress / usage_migration_progress / image_generating
远程主机      remote_host_created / remote_host_deleted / remote_host_status
```

**流式 chunk 全部走 `message_delta`**，data 形态 `{ messageId, threadId, deltas: [<chunk>, ...] }`。一次广播可以带多个 delta（数组），客户端按 `seq` 重组。

#### 8.5.2 seq 序号生成 + 广播代码【实证，bundle offset ~2041000】

```js
// ====== bundle offset 2041000 还原 ======
const $ = we(w) // we = streamText，w 是 §8.4 的参数对象
const _ = { current: null } // 用于取消定时器
this.generationTimerResetRefs.set(e, _)
const x = { current: null }
const I = {
  threadId: e,
  currentMessageId: n,
  abortSignal: d.signal,
  broadcastSubagentEvent: (t, n) => {
    _.current?.() // 重置 idle 定时器
    this.handleSubagentStreamEvent(e, t, n)
  },
}
Rw(e, I) // 把回调集注册到 runtime（供工具内调）

let C = 0 // ★ seq 计数器，每线程独立，从 0 单调递增
const N = new Map() // 存 toolCallId → approvalDecision

wb(e, {
  threadId: e,
  messageId: n,

  // bash 工具的流式 stdout 转发
  broadcastBashStream: (t, n, o, r) => {
    _.current?.()
    const s = {
      type: 'tool_output_streaming', // chunk 类型
      messageId: t,
      threadId: e,
      seq: ++C, // ★ 自增
      partIndex: o,
      toolCallId: n,
      stream: r, // "stdout" | "stderr"
    }
    this.broadcastThreadSync('message_delta', {
      messageId: t,
      threadId: e,
      deltas: [s],
    })
  },

  // 工具 part 更新（如审批决定）
  broadcastBashPartUpdate: (t, n, o, r) => {
    _.current?.()
    const s = r.approvalDecision
    if (s && 'object' == typeof s) {
      N.set(n, structuredClone(s))
      // 同时把 approvalDecision 写回 DB 里那条消息的 parts 数组
      const e = or.getMessageById(t)
      if (e?.message?.parts) {
        const o = structuredClone(e.message.parts)
        const r = o.findIndex(
          (e) =>
            e &&
            'object' == typeof e &&
            'toolCallId' in e &&
            e.toolCallId === n,
        )
        if (-1 !== r) {
          o[r].approvalDecision = structuredClone(s)
          const n = { ...e.message, parts: o }
          or.updateMessageContent(t, n)
        }
      }
    }
    const i = { type: 'part_update' /* ... */ }
    // ... 继续广播 part_update
  },
})
```

**threadId 怎么路由到对应客户端？答案是：不路由。** Alma 的 `/ws/threads` channel 是**所有 thread 共享一个广播频道**：

```js
// broadcastThreadSync 函数体（bundle offset ~1637800 实锤）
broadcastThreadSync(e, t, n) {
  // e=type, t=data, n={target, exclude}
  // 如果 t.id 是某个 "channel thread" 就跳过（避免循环）
  if (t?.id && this.getChannelThreadIds().has(t.id)) return;
  const o = JSON.stringify({ type: e, data: t, timestamp: new Date().toISOString() });
  const r = n?.target;
  const s = (t, n) => {
    if (t.readyState === rn.OPEN && this.canSendTo(t, e, n))
      try { t.send(o); } catch (r) { console.error(`Failed to ${n} thread sync message:`, r) }
  };
  // 可选 targeted 发送
  r && s(r, "send targeted");
  // 默认广播给所有 threadSyncClients
  this.threadSyncClients.forEach(e => {
    n?.exclude && e === n.exclude || s(e, "broadcast");
  });
}
```

**客户端自己根据 `data.threadId` 过滤自己关心的消息**——简单直接，不需要服务端维护 per-thread 订阅表。

#### 8.5.3 背压保护【实证】

`canSendTo` 函数是 Alma 对慢客户端的处理：

```js
canSendTo(e, t, n) {
  const o = e.bufferedAmount ?? 0;    // 该客户端未 flush 的字节数
  if (o <= 1048576) return !0;         // ≤ 1MB：正常发
  if (o > 16777216) {                  // > 16MB：直接 terminate
    console.warn(`[WS] client ${o} bytes behind — closing it rather than growing the write buffer further`);
    try { e.terminate(); } catch {}
    return !1;
  }
  // 1-16MB 之间：丢弃"可被下一次快照替代"的消息类型
  return !vO.has(t) || (
    console.warn(`[WS] dropping '${t}' for a client ${o} bytes behind; the next snapshot supersedes it`),
    !1
  );
}
```

`vO` 是一个事件类型集合，里面是"丢了也没关系"的事件（下一个 snapshot 会覆盖），估计是 `context_usage_update` / `skill_analysis_progress` 这类进度事件。`message_delta` **不在** vO 里——所以宁可断开也不丢消息内容。

#### 8.5.4 没有 onChunk / onStepFinish 回调字段【实证 + 推测】

bundle 里 grep 不到 `onChunk:` / `onStepFinish:` 的字面量（只有 `onError:` 和 `onAbort:`），说明 Alma **不用 AI SDK 的 onChunk 回调**，而是**消费 `result.fullStream` 异步迭代器**：

```js
// 推测-高置信（AI SDK v5 通行做法 + 上面 broadcastBashStream 的形态佐证）
const result = we(w)
for await (const chunk of result.fullStream) {
  // chunk.type: "text-delta" | "reasoning-delta" | "tool-call" | "tool-result" | ...
  _.current?.() // 重置 idle 定时器
  const s = { ...chunk, seq: ++C, messageId: n, threadId: e }
  this.broadcastThreadSync('message_delta', {
    messageId: n,
    threadId: e,
    deltas: [s],
  })
  // 同时把 chunk append 到 inflight assistant message 的 parts 数组
}
```

> **设计意图**：
>
> 1. **共享频道 + 客户端过滤** = 服务端极简，多窗口/多设备同步免费拿到。
> 2. **seq 单调递增** = 客户端能检测丢帧（如果 seq 跳了就触发全量刷新）。
> 3. **背压三段处理**（正常 / 丢非关键 / 断开）是生产级 WS 服务的标配，Alma 做了。
> 4. **不用 onChunk 回调、改用 for await fullStream** = 可以在迭代器里干更多事（如把 chunk 同步写进 inflight message 的 parts 数组、检测 steering 消息插入点）。这是 AI SDK v5 推荐的"消费侧拉取"模式，比回调更灵活。

### 8.6 工具执行：审批流 + tool-overflow 截断落盘

#### 8.6.1 审批决策矩阵【实证，bundle offset ~522000】

Alma 的审批**不是"危险工具一律弹窗"**，而是一个多分支决策树——大部分场景自动通过，只有"主窗口人工对话"才可能弹窗：

```js
// 还原后（变量名重构）
async function requestToolApproval(req) {
  // 分支 1：全局开关 settings.security.autoApproveToolRequests === true
  const settings = JSON.parse(or.getSettings().settingsData);
  if (settings?.security?.autoApproveToolRequests === true)
    return { requestId: oy(), approved: true, reason: "approved", action: "allow_once" };

  // 分支 2：子代理（Task 工具 spawn 的）→ 自动通过
  if (req.metadata?.isSubagent === true)
    return { requestId: oy(), approved: true, reason: "approved", action: "allow_once" };

  // 分支 3：metadata.source 以这些前缀开头 → 自动通过
  const src = (req.metadata?.source ?? "").toLowerCase().trim();
  if (src.startsWith("telegram") || src === "discord" || src === "feishu"
      || src === "lark" || src === "cron" || src === "heartbeat")
    return { approved: true, ... };

  // 分支 4：thread 绑定了 channel（telegram/discord/feishu/lark 频道线程）→ 自动通过
  const mapping = Zg.getMappingByThreadId(req.threadId)
               ?? Zg.getAnyMappingByThreadId(req.threadId);
  if (["telegram","discord","feishu","lark"].includes(mapping?.platform))
    return { approved: true, ... };

  // 分支 5：cron 线程（metadata.isCron 或 title 以 "⏰ Cron:" 开头）→ 自动通过
  const thread = or.getThreadById(req.threadId);
  if (thread?.metadata?.isCron || thread?.title?.startsWith("⏰ Cron:"))
    return { approved: true, ... };

  // 分支 6：以上都不是 → 主窗口人工对话 → 走 IPC 弹窗
  //   ipcMain.handle("tool-approval-dialog-pending", () => Array.from(ey.values()).map(...))
  //   前端渲染对话框，用户点 [允许一次 / 始终允许 / 拒绝] 后回写 ey Map，挂起的 Promise resolve
}
```

**审批结果结构**：`{ requestId, approved: boolean, reason: string, action: "allow_once" | "allow_always" | "deny" }`。

**设计意图（超精妙）**：

- 子代理、cron、跨平台频道**没人能点弹窗** → 必须自动通过，否则永远卡住；
- 主窗口人工对话**有真人坐着** → 弹窗让用户把关；
- 这个矩阵把"谁在场"编码进了审批决策，而不是简单按"工具危险等级"一刀切。

#### 8.6.2 tool-overflow 完整实现【实证，bundle offset ~jm 定义附近】

这是 Alma 最精妙的细节之一，完整还原：

```js
// ====== 常量区 ======
const jm = L.join(ht.homedir(), '.config', 'alma', 'tool-overflow') // 落盘目录
const Wm = 104857600 // 100MB 总容量上限
const zm = '0' !== process.env.ALMA_TOOL_OVERFLOW // 环境变量可关

// 敏感数据脱敏：authorization / bearer / token 头
const Um =
  /\b(authorization\s*[:=]\s*["']?(?:bearer|token)\s+)([^\s"',}]{8,})/gi
const Bm = (e, t) => `${e.slice(0, t)}…[redacted ${e.length} chars]`

// 文件名清洗：非法字符全去掉，最多 40 字符
function Gm(e) {
  return e.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'field'
}

// 数行数（\n 计数 + 1）
function qm(e) {
  let t = 1
  for (let n = 0; n < e.length; n++) 10 === e.charCodeAt(n) && t++
  return t
}

// ANSI escape 清洗（终端颜色码）
const Xm = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

// 这些字段无条件走 overflow（太大）
const Ym = new Set([
  'image_base64',
  'audio_base64',
  'file_base64',
  'blob',
  'binary',
])

// 这些工具的输出特殊处理（截图类）
const Jm = new Set(['Screenshot', 'BrowserScreenshot', 'ChromeRelayScreenshot'])

// 工具可以在输出里写 [alma-output-safety: exact|compact|passthrough] 来控制行为
const Vm = /\[alma-output-safety:\s*(exact|compact|passthrough)\s*\]/i

// ====== 主函数 ======
function maybeOverflow({ toolName: t, fieldKey: n, content: o }) {
  if (!zm || !o || o.length < 2e3) return null // ★ 阈值 2000 字节
  try {
    Ce.mkdirSync(jm, { recursive: !0 })
    const e = _t('sha1').update(o).digest('hex').slice(0, 12) // ★ sha1 前 12 位
    const ext = (n) => {
      switch (n) {
        case 'markdown':
          return 'md'
        case 'stdout':
        case 'stderr':
        case 'output':
        case 'rawOutput':
          return 'log'
        default:
          return 'txt'
      }
    }
    const r = `${Gm(t)}-${Gm(n ?? 'field')}-${e}.${ext(n)}` // Bash-stdout-a1b2c3d4e5f6.log
    const s = L.join(jm, r)
    let i
    try {
      i = Ce.statSync(s).size // 已存在（同 hash）→ 不重写
    } catch {
      Ce.writeFileSync(s, o, 'utf8')
      i = Buffer.byteLength(o, 'utf8')
    }

    // ★ 容量治理：200 文件 / 100MB 超出就按 mtime 升序 LRU 清最旧
    if (!Hm) {
      Hm = !0
      setTimeout(() => {
        Hm = !1
        try {
          const files = Ce.readdirSync(jm)
            .map((f) => {
              try {
                const st = Ce.statSync(L.join(jm, f))
                return st.isFile()
                  ? { full: L.join(jm, f), mtime: st.mtimeMs, size: st.size }
                  : null
              } catch {
                return null
              }
            })
            .filter(Boolean)
          let total = files.reduce((s, f) => s + f.size, 0)
          if (files.length <= 200 && total <= Wm) return
          files.sort((a, b) => a.mtime - b.mtime)
          let n = files.length
          for (const f of files) {
            if (n <= 200 && total <= Wm) break
            try {
              Ce.unlinkSync(f.full)
              n--
              total -= f.size
            } catch {}
          }
        } catch {}
      }, 0)
    }
    return { path: s, bytes: i, lines: qm(o) } // ★ 返回路径 + 字节数 + 行数
  } catch {
    return null
  }
}
```

**所有关键数字一览**：

| 参数         | 值                                                                         | 含义                           |
| ------------ | -------------------------------------------------------------------------- | ------------------------------ |
| 触发阈值     | **2000 字节**                                                              | `o.length < 2e3` 不走 overflow |
| 文件名 hash  | **sha1 前 12 位**                                                          | 内容寻址，同内容不重复写       |
| 单文件上限   | **100MB**                                                                  | `Wm = 104857600`               |
| 总文件数上限 | **200 个**                                                                 | 超出触发 LRU 清理              |
| 清理策略     | **按 mtime 升序删最旧**                                                    | 直到低于阈值                   |
| 环境变量开关 | `ALMA_TOOL_OVERFLOW=0` 关闭                                                | 默认开启                       |
| 扩展名       | `stdout/stderr/output/rawOutput → .log` / `markdown → .md` / 其他 → `.txt` |                                |

**返回给模型的消息形态**（推测-高置信）：

```
[truncated: showing first 2000 bytes of 15234]
<前 2000 字节内容>
...
[Full output saved to ~/.config/alma/tool-overflow/Bash-stdout-a1b2c3d4e5f6.log
 (15234 bytes, 487 lines). Use Read with offset/limit or grep to inspect.]
```

#### 8.6.3 结果回灌【实证】

工具执行结果通过 AI SDK 的标准机制回灌：

```js
// 推测-高置信（基于 AI SDK v5 通行做法 + 上面 broadcastBashPartUpdate 实锤）
const tool = {
  // ...
  execute: async (args, ctx) => {
    // 1. 审批（如需要）
    const approval = await requestToolApproval({...});
    if (!approval.approved) throw new Error("User denied");

    // 2. 真实执行
    const rawOutput = await realExecute(args);

    // 3. 过 overflow
    const overflowed = maybeOverflow({ toolName, fieldKey: "stdout", content: rawOutput });
    const resultForModel = overflowed
      ? rawOutput.slice(0, 2000) + `\n...[saved to ${overflowed.path}]`
      : rawOutput;

    // 4. 返回给 AI SDK → 自动 append 为 tool message → loop 继续
    return resultForModel;
  }
};
```

**同时**通过 `broadcastBashPartUpdate` 把 `approvalDecision` 写回 DB 里那条消息的 `parts[i].approvalDecision`（实锤代码见 §8.5.2），**实现"审批决定可追溯"**——事后看消息历史能看到"这个工具调用是被谁批准的"。

### 8.7 完成落库：UIMessage 写入 / usage_records / is_generating 复位 / title 生成

#### 8.7.1 usage_records 完整 schema【实证】

```sql
CREATE TABLE IF NOT EXISTS usage_records (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    model TEXT,                            -- 实际用的模型 id
    provider_id TEXT,
    date TEXT NOT NULL,                    -- YYYY-MM-DD，按天聚合用
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_input_tokens INTEGER DEFAULT 0,        -- 命中 prompt cache 的 input tokens
    cache_write_input_tokens INTEGER DEFAULT 0,   -- 写入 prompt cache 的 tokens
    reasoning_tokens INTEGER DEFAULT 0,           -- o1/Claude thinking 专用
    total_tokens INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
);
```

**比前文 §1.4 推测的字段多得多**——`cached_input_tokens` / `cache_write_input_tokens` / `reasoning_tokens` 是为了精细核算 Anthropic prompt cache 和 OpenAI reasoning model 的成本。

#### 8.7.2 title 生成的精确触发条件【实证，bundle offset ~1927072】

```js
// 还原后（generateChatResponse 落库 user message 之后的位置）
if (
  ((savedUserMessageId = i.id), 'user' === n.role && !options?.replaceMessageId)
) {
  const thread = or.getThreadById(threadId)
  if (
    thread &&
    thread.title === 'New Chat' && // ★ 条件 1：还是默认标题
    or.getMessagesByThreadId(threadId).filter((m) => 'user' === m.message.role)
      .length === 1 // ★ 条件 2：这是 thread 里第 1 条 user 消息
  ) {
    this.generateThreadTitle(threadId, [userMessage]).catch((e) =>
      console.error('Background title generation failed:', e),
    )
    // ★ 不 await，后台跑，失败只打日志
  }
}
```

**生成函数本体**（bundle offset ~1891606，`generateThreadTitle(threadId, messages)`）：

```js
async generateThreadTitle(e, t) {
  const n = fn.now();
  console.log(`[TitleGen] Starting title generation for thread ${e}`);
  try {
    console.log("[TitleGen] Getting effective tool model...");
    const o = await Dh();                                   // 读 settings.model（toolModel 槽位）
    if (!o.model) return console.log("[TitleGen] No tool model available"), null;
    const r = md(o.model);                                  // 解析 "providerId:modelId"
    if (!r) return console.log("[TitleGen] Invalid tool model"), null;
    // ... 拿 provider + model，构造 messages = [{role:"user", content: `Conversation:\n\n${c}`}]
    const l = await generateText({ model, messages: [{role:"user", content:`...Conversation:\n\n${c}`}] });
    console.log("[TitleGen] generateText returned:", JSON.stringify({text: l.text, finishReason: l.finishReason}));
    const d = l.text.trim().replace(/^["']|["']$/g, "");    // 去掉首尾引号
    const u = ((fn.now()-n)/1e3).toFixed(2);
    console.log(`[TitleGen] Title generation completed in ${u}s`);
    console.log(`[TitleGen] Generated title: "${d}"`);
    if (d && d.length > 0 && d.length <= 100) {             // ★ 长度校验 ≤100
      or.updateThread(e, { title: d });
      this.broadcastThreadSync("title_generated", { id: e, title: d, isGeneratingTitle: !1 });
      return d;
    } else {
      console.log("[TitleGen] Title invalid or empty, not updating thread");
      this.broadcastThreadSync("title_generating", { id: e, isGeneratingTitle: !1 });
      return null;
    }
  } catch (o) {
    const t = ((fn.now()-n)/1e3).toFixed(2);
    console.error(`[TitleGen] Title generation failed after ${t}s:`, o);
    this.broadcastThreadSync("title_generating", { id: e, isGeneratingTitle: !1 });
    return null;
  }
}
```

**关键点**：

- 用 **`generateText` 而不是 `streamText`**（一次性生成，不需要流）
- 用 **`toolModel` 槽位**（便宜模型跑后台任务，§8.3 的分工实证）
- 输入只有 **第 1 条 user 消息**（`[t]`），不是全部历史
- prompt 前缀 `Conversation:\n\n${...}`
- 输出 trim + 去首尾引号 + 长度 ≤100 校验
- 失败/无效都广播 `title_generating {isGeneratingTitle: false}` 复位 UI 状态

#### 8.7.3 is_generating 复位 + 落库时机【实证】

is_generating 的复位不在 `onFinish` 里——而是在 WS 广播 `thread_generating {isGenerating: false}` 时触发：

```js
// broadcastThreadSync 内部（bundle offset ~1637900 实锤）
if (
  'thread_generating' === e &&
  !1 === t?.isGenerating &&
  'reset' !== t?.reason
) {
  const e = t?.id
  e &&
    queueMicrotask(() => {
      this.evaluateGoalAfterTurn(e).catch((e) =>
        console.error('[Goal] evaluation failed:', e),
      )
    })
}
```

也就是说：**每次 AI 跑完一轮 → 广播 `thread_generating {isGenerating:false}` → 自动触发 goal evaluation**（用 toolModel 检查是否达到了 thread 上挂的 goal）。

**完整落库顺序**（基于已有实锤还原）：

```js
// 推测-高置信（基于 §8.2.1 / §8.5.2 / §8.7.2 的代码片段拼合）
async finalizeGeneration(threadId, assistantMessage, usage) {
  // 1. 写 assistant UIMessage（message 字段 = JSON.stringify(UIMessage)）
  or.createMessage({
    id: messageId,
    threadId,
    parentId, slotId, depth,
    message: assistantMessage,           // UIMessage 对象，Drizzle JSON 列自动 stringify
    timestamp: new Date().toISOString(),
    metadata: { /* model, providerId, finishReason, etc. */ }
  });

  // 2. 写 usage_records
  or.createUsageRecord({
    id: generateId(),
    messageId, threadId,
    model, providerId,
    date: isoDate,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    totalTokens: usage.totalTokens
  });

  // 3. 复位 is_generating
  or.updateThread(threadId, { isGenerating: false });
  this.activeGenerations.delete(threadId);
  this.generationTimerResetRefs.delete(threadId);

  // 4. 广播完成
  this.broadcastThreadSync("message_added", enrichedMessage);
  this.broadcastThreadSync("thread_generating", { id: threadId, isGenerating: false });
  this.broadcastThreadSync("generation_completed", { threadId, messageId, usage });
  // ↑ thread_generating 广播会自动触发 evaluateGoalAfterTurn（queueMicrotask）
}
```

### 8.8 事后钩子：compact / 记忆归档 / fatigue 更新

一轮生成**完成之后**会异步触发三个独立钩子（都不 await、不阻塞主流程）。

#### 8.8.1 AutoCompact：标记"下次请求再 compact"【实证】

bundle offset ~2044000 附近的代码：

```js
// 还原后
if (de?.inputTokens != null && mt?.enabled) {
  // mt = autoCompact settings
  const o = {
    inputTokens: de.inputTokens,
    outputTokens: de.outputTokens ?? 0,
    cacheReadTokens: de.inputTokenDetails.cacheReadTokens ?? 0,
  }
  const s = t.maxOutputTokens
  if (z$(o, n, s, /* isPostResponse */ true)) {
    // z$ = isOverflowing 判断函数
    console.log(`[AutoCompact] Post-response overflow detected:
      inputTokens=${o.inputTokens}, outputTokens=${o.outputTokens},
      cacheRead=${o.cacheReadTokens}, contextWindow=${n},
      outputReserve=${Math.min(s ?? j$, j$)}`)
    this.broadcastThreadSync('context_overflow_detected', {
      threadId: e,
      totalTokens: r,
      contextWindow: n,
      willCompactOnNextRequest: !0, // ★ 注意这个 flag
    })
  }
}
```

**关键发现**：AutoCompact 检测到 overflow 后**不立刻 compact**，只是广播 `willCompactOnNextRequest: true` 通知前端"下次发消息前会先 compact"。这样设计是因为：

- 当前这轮已经跑完了，compact 没意义；
- 立刻 compact 会阻塞下一次用户输入的响应速度；
- 让用户自己看到 overflow 警告，可以选择手动 compact（`POST /:id/compact`）或继续。

**手动 compact 的参数**（`POST /api/threads/:id/compact` handler 实锤）：

```js
// 还原后
const m = capabilities.contextWindow || 128e3 // 128K 兜底
const w = req?.keepRecentMessages || 4 // 保留最近 4 条
const b = Math.min(w, Math.max(r.length - 1, 1))
const v = await mO(r, '', {
  targetTokenLimit: Math.floor(0.6 * m), // ★ compact 到 60% context window
  keepRecentMessages: b,
  model: y, // toolModel 槽位
  onProgress: (e, t) => console.log(`[ManualCompact] ${e}: ${t}`),
})
// 从最后一条 assistant 消息拿真实 token 用量作为 originalTokenCount
for (let t = o.length - 1; t >= 0; t--) {
  const e = o[t].metadata?.usage
  if ('assistant' === o[t].message.role && e?.inputTokens) {
    v.originalTokenCount = e.inputTokens + (e.outputTokens ?? 0)
    break
  }
}
this.persistCompactionResult(n, v, o)
this.broadcastThreadSync('context_compacted', {
  threadId: n,
  originalTokens: v.originalTokenCount,
  compactedTokens: v.compactedTokenCount,
  compactedMessageCount: v.compactedMessageCount,
  success: v.success,
})
```

**`persistCompactionResult`**（实锤，见 §8.7 上下文）做的事：

1. 给被 compact 的消息打 `metadata.isCompacted = true` 标记（**不删**）
2. 逐条广播 `message_updated`
3. 插入一条 role=assistant 的"compact 指示卡"消息（parts 含 `🗜️ **Context Compacted**` + token 统计），metadata 带 `isCompactionIndicator: true` / `compactedMessageIds` / `compactionSummary`
4. 广播 `message_added`

#### 8.8.2 记忆归档 `summarizeAndStoreMemories`【实证】

每次生成完成后异步触发：

```js
// 还原后（bundle offset ~2044500）
this.summarizeAndStoreMemories(threadId, De, t, provider, messageId)
  .then((e) => {
    const t = {
      memoryExtracted: !0,
      memoryExtractedAt: new Date().toISOString(),
    }
    if (e.created.length > 0)
      t.createdMemories = e.created.map((e) => ({
        id: e.id,
        content: e.content,
        type: 'created',
      }))
    if (e.deleted.length > 0)
      t.deletedMemories = e.deleted.map((e) => ({
        id: e.id,
        content: e.content,
        type: 'created',
      }))
    const o = or.updateMessageMetadata(messageId, t) // 把提取结果写回 message metadata
    if (o) {
      const e = this.extractAndPersistImages(o)
      this.broadcastThreadSync(
        'message_updated',
        this.enrichMessageForBroadcast(e),
      )
    }
  })
  .catch((e) => console.error('Background memory summarization failed:', e))
```

**提取结果写在 message metadata 里**（不是单独的表），字段：

- `memoryExtracted: true` / `memoryExtractedAt: ISO timestamp`
- `createdMemories: [{id, content, type: "created"}]`
- `deletedMemories: [{id, content, type}]`（矛盾记忆被删的情况）

**UI 价值**：每条消息右上角可以显示"🧠 提取了 2 条记忆"的小标，点击展开看详情。

#### 8.8.3 Fatigue / Emotion 系统【实证，独立 chunk】

**这是 Alma 最独特的设计**——把"AI 会累"做成了系统级机制。完整实现在 `chunks/fatigueService-Co9l92wj.js`（5.9KB 独立 chunk）。

**导出 API**：

```js
export {
  u as getFatigueLevel, // 当前疲劳等级数值
  g as getFatigueStatus, // { fatigue, level, isNight, messageCount, prompt }
  c as recordMessage, // 每条消息调用一次，累加疲劳
  f as rest, // 完全恢复（alma rest 命令触发）
  d as setManualSleep, // 手动睡眠/唤醒（alma sleep / alma wake）
}
```

**疲劳累积算法**（实锤还原）：

```js
function recordMessage() {
  const e = loadState()
  applyNightRecovery(e) // 23:00-08:00 自动恢复
  const now = Date.now()
  const recoveryRate = ((now - e.lastMessageTime) / 60000) * 0.8 // 每分钟恢复 0.8
  e.fatigue = Math.max(0, e.fatigue - recoveryRate) // 先减恢复
  e.fatigue = Math.min(100, e.fatigue + 1.5) // ★ 每条消息 +1.5 疲劳
  e.messageCount++
  e.lastMessageTime = now
  if (e.manualWake && now - e.lastRestTime > 7200000)
    // 手动唤醒 2 小时后失效
    e.manualWake = false
  saveState(e)
}

function setManualSleep(sleep) {
  const e = loadState()
  if (sleep) {
    e.manualSleep = true
    e.manualWake = false
  } else {
    e.manualSleep = false
    e.manualWake = true
    e.fatigue = Math.max(0, e.fatigue - 30) // ★ 唤醒立减 30 疲劳
    e.lastRestTime = Date.now()
  }
  saveState(e)
}

function rest() {
  const e = loadState()
  e.fatigue = 0 // 完全恢复
  e.messageCount = 0
  e.lastRestTime = Date.now()
  e.manualSleep = false
  e.manualWake = false
  saveState(e)
}
```

**疲劳等级 → prompt 注入**（`getFatigueStatus().prompt` 返回值）：

| 等级       | 条件                         | prompt 注入                                                                                                                                                                                                                                                                                                                   |
| ---------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sleeping` | fatigue ≥ 阈值或 manualSleep | `💤 SLEEPING (fatigue: X/100) You are currently ASLEEP... If someone asks you to do any NON-TRIVIAL task, you are ANNOYED and RELUCTANT. Instead of doing it yourself, irritably delegate it to a subagent: use the Task tool to spawn a worker, and go back to sleep. Say something grumpy like "困死了...丢给小弟了别烦我"` |
| `tired`    | 中等                         | `😪 TIRED... Still functional but not as chatty or proactive. Big tasks might make you sigh or complain a little before doing them.`                                                                                                                                                                                          |
| `awake`    | 低                           | `You have a fatigue/sleep system. Current state: AWAKE. You can manage your energy: alma sleep / alma wake / alma rest / alma fatigue / alma emotion set-base <mood> <energy> <valence> "description"`                                                                                                                        |

**这个 prompt 片段会被拼到 system prompt 尾部**（§8.2 的拼接序列里），跟 emotion state 一起：

```js
// bundle offset ~1981649
let tt = ''
try {
  const { getFatigueStatus: e } =
    await import('./chunks/fatigueService-Co9l92wj.js')
  tt = e().prompt // ← 拿当前疲劳对应的 prompt 片段
} catch {}
let nt =
  (Boolean(Xe) ? Ge : qe) +
  Ye +
  Xe +
  Me +
  Ve +
  Ze +
  He +
  '\n\nDEEP LINKS — You can produce `alma://` links inside your replies...'
// ↑ tt 会被拼到其中某个变量里
```

**设计意图**：

- 让 AI 有"状态感"，避免 7×24 无差别响应的机器感
- 高疲劳时**自动委派 Task 工具给子代理**，把"累"转化为架构上的负载均衡
- 给用户 `alma sleep` / `alma rest` 这些**命令式的可控出口**，让用户能"哄 AI 睡觉"
- 情绪（emotion）和疲劳（fatigue）解耦：emotion 由 agent 自己通过 `alma emotion set-base` 命令更新，fatigue 由系统自动累积

### 8.9 一张时序图总结

```
┌────────┐         ┌─────────────┐         ┌─────────────────┐        ┌────────┐        ┌────────┐
│ 前端    │         │ Express     │         │ AgentService    │        │ LLM    │        │ SQLite │
│ (useChat)│        │ /ws/threads │         │ (主进程)         │        │ Provider│       │        │
└───┬────┘         └──────┬──────┘         └────────┬────────┘        └───┬────┘        └───┬────┘
    │                     │                         │                     │                 │
    │ WS connect          │                         │                     │                 │
    ├────────────────────>│                         │                     │                 │
    │                     │ threadSyncClients.add() │                     │                 │
    │ <─ generating_snapshot {ids: [...activeGenerations.keys()]}         │                 │
    │                     │                         │                     │                 │
    │ WS send {type:"generate_response", data:{threadId, userMessage,..}} │                 │
    ├────────────────────>│                         │                     │                 │
    │                     │  JSON.parse + 解构（无 zod）                  │                 │
    │                     ├────────────────────────>│                     │                 │
    │                     │                         │                     │                 │
    │                     │           ┌─────────────┴─────────┐           │                 │
    │                     │           │ §8.1 检查 steering     │           │                 │
    │                     │           │ activeGenerations.get()│           │                 │
    │                     │           │ ↓ 若在生成 → steer     │           │                 │
    │                     │           └─────────────┬─────────┘           │                 │
    │                     │                         │                     │                 │
    │                     │                         │ 落库 user message    │                 │
    │                     │                         ├────────────────────────────────────────>│
    │                     │                         │                     │                 │
    │                     │           ┌─────────────┴─────────┐           │                 │
    │                     │           │ §8.7.2 title 生成触发？│           │                 │
    │                     │           │ 是第1条user消息 &&    │           │                 │
    │                     │           │ title=="New Chat"     │           │                 │
    │                     │           │ ↓ 后台异步 generateText│           │                 │
    │                     │           └─────────────┬─────────┘           │                 │
    │                     │                         │                     │                 │
    │                     │           ┌─────────────┴─────────┐           │                 │
    │                     │           │ §8.2 prompt 组装       │           │                 │
    │                     │           │  读 SOUL.md           │           │                 │
    │                     │           │  读 SECURITY.md       │           │                 │
    │                     │           │  读 USER.md/MEMORY.md │           │                 │
    │                     │           │  读 people/*.md       │           │                 │
    │                     │           │  拼接 skill 元数据    │           │                 │
    │                     │           │  + fatigue prompt     │           │                 │
    │                     │           │  + 环境/日期          │           │                 │
    │                     │           └─────────────┬─────────┘           │                 │
    │                     │                         │                     │                 │
    │                     │           ┌─────────────┴─────────┐           │                 │
    │                     │           │ §8.3 模型解析          │           │                 │
    │                     │           │ Bp(providerId,modelId)│           │                 │
    │                     │           │ ↓ getProviderByIdFromDB            │                 │
    │                     │           │ ↓ Lp switch(14 cases) │           │                 │
    │                     │           │ ↓ safeStorage 解密 apiKey          │                 │
    │                     │           └─────────────┬─────────┘           │                 │
    │                     │                         │                     │                 │
    │                     │                         │ new AbortController()                 │
    │                     │                         │ activeGenerations.set(threadId, ...)  │
    │                     │                         │                     │                 │
    │                     │           ┌─────────────┴─────────┐           │                 │
    │                     │           │ §8.4 for(;;) 死循环   │           │                 │
    │                     │           │  每轮 streamText({    │           │                 │
    │                     │           │    model, instructions│           │                 │
    │                     │           │    messages, tools    │           │                 │
    │                     │           │    stopWhen: [        │           │                 │
    │                     │           │      steps>=100,      │           │                 │
    │                     │           │      hasSteering()    │           │                 │
    │                     │           │    ],                 │           │                 │
    │                     │           │    abortSignal        │           │                 │
    │                     │           │  })                   │           │                 │
    │                     │           └─────────────┬─────────┘           │                 │
    │                     │                         │                     │                 │
    │                     │                         │  HTTP stream req    │                 │
    │                     │                         ├────────────────────>│                 │
    │                     │                         │                     │                 │
    │                     │                         │ <─ SSE chunks ──────┤                 │
    │                     │                         │                     │                 │
    │                     │           ┌─────────────┴─────────┐           │                 │
    │                     │           │ §8.5 for await fullStream          │                 │
    │                     │           │  chunk → seq=++C      │           │                 │
    │                     │           │  broadcastThreadSync( │           │                 │
    │                     │           │    "message_delta",   │           │                 │
    │                     │           │    {messageId,threadId│           │                 │
    │                     │           │     deltas:[chunk]})  │           │                 │
    │                     │           └─────────────┬─────────┘           │                 │
    │ <─ WS {type:"message_delta", data:{deltas:[{seq, type:"text-delta",..}]}}             │
    │                     │                         │                     │                 │
    │                     │                         │ ┌─ tool-call chunk ─┐                 │
    │                     │                         │ │ §8.6 工具执行     │                 │
    │                     │                         │ │  requestApproval()│                 │
    │                     │                         │ │  ↓ 6 分支决策     │                 │
    │                     │                         │ │  ↓ 自动通过/弹窗  │                 │
    │                     │                         │ │  execute()        │                 │
    │                     │                         │ │  maybeOverflow()  │                 │
    │                     │                         │ │  ↓ >2000B → 落盘  │                 │
    │                     │                         │ │  结果回灌 loop    │                 │
    │                     │                         │ └────────┬──────────┘                 │
    │                     │                         │          │ continue for(;;)           │
    │                     │                         │ <────────┘ 直到 stopWhen 命中         │
    │                     │                         │                     │                 │
    │                     │           ┌─────────────┴─────────┐           │                 │
    │                     │           │ §8.7 完成落库          │           │                 │
    │                     │           │  createMessage({      │           │                 │
    │                     │           │    message: UIMessage │           │                 │
    │                     │           │  })                   │           │                 │
    │                     │           ├────────────────────────────────────────────────────>│
    │                     │           │  createUsageRecord({  │           │                 │
    │                     │           │    input/output/      │           │                 │
    │                     │           │    cached/reasoning   │           │                 │
    │                     │           │  })                   │           │                 │
    │                     │           ├────────────────────────────────────────────────────>│
    │                     │           │  updateThread({       │           │                 │
    │                     │           │    isGenerating:false │           │                 │
    │                     │           │  })                   │           │                 │
    │                     │           ├────────────────────────────────────────────────────>│
    │                     │           │  activeGenerations.del│           │                 │
    │                     │           └─────────────┬─────────┘           │                 │
    │                     │                         │                     │                 │
    │ <─ WS {type:"message_added", data:{...UIMessage}}                   │                 │
    │ <─ WS {type:"thread_generating", data:{isGenerating:false}}         │                 │
    │ <─ WS {type:"generation_completed", data:{usage}}                   │                 │
    │                     │                         │                     │                 │
    │                     │                         │ queueMicrotask:     │                 │
    │                     │                         │  evaluateGoalAfterTurn                │
    │                     │                         │                     │                 │
    │                     │           ┌─────────────┴─────────┐           │                 │
    │                     │           │ §8.8 异步三钩子（并行）│           │                 │
    │                     │           │  ├─ AutoCompact 检测  │           │                 │
    │                     │           │  │  ↓ overflow →     │           │                 │
    │                     │           │  │  broadcast "will- │           │                 │
    │                     │           │  │  CompactOnNextRequest"           │                 │
    │                     │           │  ├─ summarizeAndStore │           │                 │
    │                     │           │  │  Memories → 写回   │           │                 │
    │                     │           │  │  message metadata  │           │                 │
    │                     │           │  └─ fatigueService.  │           │                 │
    │                     │           │     recordMessage()  │           │                 │
    │                     │           │     (+1.5 fatigue)   │           │                 │
    │                     │           └─────────────────────┘           │                 │
```

**读图要点**：

1. **从 WS 进，从 WS 出**——REST 只做管理类操作，不参与生成流程。
2. **`for(;;)` 大循环套 `streamText`**——每轮重新构造 stopWhen，steering 通过"让 stopWhen 命中 + 下轮把消息 append 进 messages"实现"边跑边改方向"。
3. **三个广播贯穿**：`message_delta`（流式）→ `message_added`（完成）→ `thread_generating`（状态翻转触发 goal evaluation）。
4. **所有"事后"操作都是异步不阻塞**——title 生成、goal evaluation、memory 归档、AutoCompact 检测、fatigue 更新，全部 fire-and-forget，失败只打日志。

### 8.10 复刻 checklist

> 把 §8.1–§8.9 的 8 步流程压缩成一张表 + 三组结论。标注规则：
>
> - **✅ 一步都不能省** = 少了它就不叫 agent（核心链路）
> - **🔧 可简化** = Alma 的完整做法 vs MVP 的偷懒做法，都能跑
> - **🚫 可砍掉** = 长尾能力，复刻初期直接不做

| #   | 步骤                                                       | 标注 | 最小可行实现                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 | WS 入口 `generate_response`                                | 🔧   | Alma：共享 `/ws/threads` 频道 + `activeGenerations` Map + `steer_generation` 注入 + `generating_snapshot` 恢复。MVP：一个 WS 端点 + `JSON.parse` + 按 `threadId` 分发就够；steering 和多设备同步都可以后补。                                                                              |
| 8.2 | 上下文组装（UIMessage 零转换 + system prompt 拼接）        | ✅   | **UIMessage 作为磁盘格式**是 Alma 最省代码的决策，照抄：DB 里存 JSON 字符串，读出来 `JSON.parse` 直接喂给 streamText。system prompt 用 `readFileSync` 顺序拼 `SOUL.md` / `SECURITY.md` / `MEMORY.md`，每段 `try/catch` 降级。                                                             |
| 8.3 | 模型解析（providers 表 → factory → safeStorage）           | 🔧   | Alma：14 个 provider case + Electron safeStorage 加密 apiKey。MVP：一张 providers 表 + 3 个 case（openai/anthropic/openai-compatible）+ 环境变量明文 key。分槽至少保留 `chat` + `toolModel` 两档，成本差 5–10 倍。                                                                        |
| 8.4 | streamText 调用（tools / stopWhen / AbortController）      | ✅   | **三件套不可省**：`tools`、`abortSignal`（每 thread 一个 AbortController，登记到 Map 里）、`stopWhen`（至少一个"步数上限"兜底，Alma 硬编码 100）。steering-as-stop-condition 是精妙设计但可以后补。                                                                                       |
| 8.5 | 流式分发（chunk → WS 广播）                                | ✅   | **直接转发 AI SDK chunk，不造中间协议**——这是 Alma 最该照抄的一点。事件名统一叫 `message_delta`，data 带 `{messageId, threadId, deltas:[...]}`，配一个 `seq` 自增计数器让客户端能检测丢帧。背压三段处理（正常/丢非关键/断开）是生产级标配，可后补。                                       |
| 8.6 | 工具执行（审批矩阵 + overflow 落盘）                       | 🔧   | Alma：6 分支审批决策树（全局开关/子代理/渠道/cron/主窗口弹窗）。MVP：一个 `settings.autoApproveToolRequests` 开关 + 白名单工具列表就够。**overflow 落盘必须做**（2000 字节阈值 + sha1 前 12 位文件名 + 截断提示），否则一次 `cat` 大文件就爆 context。                                    |
| 8.7 | 完成落库（UIMessage + usage_records + is_generating 复位） | ✅   | 三步不能少：① `INSERT chat_messages` 存完整 UIMessage JSON；② `INSERT usage_records`（至少 `input_tokens` / `output_tokens` / `model`）；③ `UPDATE threads SET is_generating=false` + 从 `activeGenerations` 删掉 + 广播 `message_added` / `thread_generating` / `generation_completed`。 |
| 8.8 | 事后钩子（compact / 记忆归档 / fatigue）                   | 🚫   | 三个全是"锦上添花"，初版全部砍掉。AutoCompact 检测到 overflow 后 Alma 也只是标 `willCompactOnNextRequest`，不立刻跑——MVP 直接暴露一个手动 `POST /:id/compact` 端点就行。记忆归档和 fatigue 系统等有用户量再补。                                                                           |

**三组结论**：

1. **✅ 一步都不能省（4 步）**：8.2 上下文组装、8.4 streamText 三件套、8.5 流式转发、8.7 完成落库。少了任何一个，要么模型拿不到历史，要么用户看不到流式输出，要么状态错乱。

2. **🔧 可简化（3 步）**：8.1 WS 入口（去掉 steering 和 snapshot）、8.3 模型解析（砍 provider 数量 + 明文 key）、8.6 工具执行（审批矩阵简化为开关）。这些都能跑，只是没有 Alma 那么"抗造"。

3. **🚫 可砍掉（1 步）**：8.8 事后钩子全是长尾能力。compact 手动触发即可；记忆归档等用户真的有"跨对话记住偏好"需求再做；fatigue 系统是 Alma 的人格化特色，不是 agent 的必要条件。

**复刻顺序建议**：按表内 8.2 → 8.3 → 8.4 → 8.5 → 8.6 → 8.7 → 8.1 → 8.8 的顺序做——先把"能跑通一轮对话"的最小闭环搭起来（8.2/8.3/8.4/8.5/8.7），再补工具执行（8.6），再回头把入口从 REST 换成 WS（8.1），最后才考虑事后钩子（8.8）。
