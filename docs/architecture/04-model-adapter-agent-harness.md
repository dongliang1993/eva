# 04 · Alma 模型适配层 与 Agent 执行层

> 范围：从 "providers 表 + AI SDK" 到 "agent loop + 工具系统 + 子代理 + skill/MCP/插件 + 权限审批 + prompt 组装" 的完整链路。
> 证据基础：对 Alma 主进程 bundle（asar 解包后 grep）、SQLite schema、`/api/*` 实测路由、`~/Library/Application Support/alma/` 文件布局的 134 步分析。
> 标注规则：【实证】= bundle/schema/路由直接命中；【推测】= 基于实证 + AI SDK 通行做法的合理还原。

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

| 类别 | 工具名 |
|---|---|
| 文件 | `Read` / `Write` / `Edit` / `Glob` / `Grep` / `MultiEdit` |
| 执行 | `Bash`（含 `run_in_background`）/ `BashOutput` |
| 网络 | `WebFetch` / `WebSearch` |
| 任务编排 | `Task`（子代理）/ `TodoWrite` / `TodoRead` |
| 浏览器 | `Browser*`（computer-use 系列，~25 条 `/api/computer-use/...` 路由） |
| 桌面 | `ComputerUse*`（click/type/scroll/shot/snap/launch_app） |
| MCP | `mcp__<server>__<tool>`（动态前缀） |
| 元 | `Skill`（调用 skill）、`SendFile`（把产物发给用户） |

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
  description: "Spawn a sub-agent to handle a sub-task",
  parameters: z.object({
    description: z.string(),
    prompt: z.string(),
    subagent_type: z.enum(["general-purpose","explore","plan","researcher","developer","designer","product-manager","operator"])
  }),
  execute: async ({ prompt, subagent_type }) => spawnAgent(subagent_type, prompt)
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

| 维度 | Skill | MCP | 插件 (plugins/) |
|---|---|---|---|
| **本质** | 一个 `SKILL.md`（YAML frontmatter + Markdown 指令） | 一个 MCP server（stdio 或 HTTP） | 一个前端 + 后端组合的扩展包 |
| **存放** | `~/.config/alma/skills/<name>/SKILL.md` 或内置 bundle | `~/.config/alma/mcp.json`（或 DB `mcp_servers` 表） | `plugins/<name>/`（含 permissions/settings） |
| **谁调用** | 主 agent 通过 `Skill` 工具按需加载 | 主 agent 自动发现为 `mcp__<server>__<tool>` | Electron 主进程 + 渲染进程同时挂载 |
| **渐进披露** | ✅ 三级：metadata (name+desc) → SKILL.md 全文 → 附属文件按需读 | ✅ 工具列表先注册，schema 用时再拉 | 部分（路由懒加载） |
| **能否新增工具** | 间接（通过指令让 agent 用现有工具组合） | ✅ 直接新增 namespaced 工具 | ✅ 可新增 UI、API 路由、工具 |
| **权限模型** | 无（继承主 agent） | OAuth token 表 `mcp_oauth_tokens` | 独立 `plugin_permissions` 表 |
| **适用场景** | 教 agent 新"做法"（流程/规范/模板） | 接外部 SaaS / 本地服务 | 改 UI、加主题、加完整功能模块 |
| **WS 频道** | `/ws/skills`（变更广播） | `/ws/mcp-resources`（资源订阅） | — |

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
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

function resolveModel(db, slotKey: "chat" | "toolModel") {
  const settings = getSettings(db);
  const { providerId, modelId } = settings[slotKey];
  const p = db.prepare("SELECT * FROM providers WHERE id=?").get(providerId);
  const apiKey = decrypt(p.api_key);
  const factory = { openai: createOpenAI, anthropic: createAnthropic }[p.type];
  return factory({ apiKey, baseURL: p.base_url })(modelId);
}
```

```ts
// ========== 2. 工具定义（含 tool-overflow）==========
import { tool } from "ai";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OVERFLOW_DIR = path.join(os.homedir(), ".config/alma/tool-overflow");
const OVERFLOW_LIMIT = 4000;
fs.mkdirSync(OVERFLOW_DIR, { recursive: true });

function maybeOverflow(toolName: string, field: string, text: string): string {
  if (text.length <= OVERFLOW_LIMIT) return text;
  const file = path.join(OVERFLOW_DIR, `${toolName}-${field}-${Date.now()}.log`);
  fs.writeFileSync(file, text);
  return text.slice(0, OVERFLOW_LIMIT) +
    `\n...[truncated, full output saved to ${file}; read with Read offset/limit or grep]`;
}

const bashTool = tool({
  description: "Run a bash command",
  parameters: z.object({
    command: z.string(),
    run_in_background: z.boolean().optional()
  }),
  execute: async ({ command }) => {
    const out = await execBash(command);          // 你自己的实现
    return maybeOverflow("Bash", "stdout", out);
  }
});

const readTool = tool({
  description: "Read file with offset/limit",
  parameters: z.object({
    file_path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional()
  }),
  execute: async ({ file_path, offset = 1, limit = 2000 }) =>
    maybeOverflow("Read", "content", readSlice(file_path, offset, limit))
});

// ... Write / Edit / Glob / Grep / WebFetch / Task 同理
const builtinTools = { Bash: bashTool, Read: readTool /* ... */ };
```

```ts
// ========== 3. 子代理（Task 工具）==========
const AGENT_REGISTRY = {
  "general-purpose": { system: "You are a general agent.", delegates: [] },
  "researcher":      { system: "You are the researcher.",  delegates: ["developer","product-manager","designer"] },
  "developer":       { system: "You are the developer.",   delegates: ["researcher","operator"] },
  // ...
};

const taskTool = (parentCtx) => tool({
  description: "Spawn a sub-agent",
  parameters: z.object({
    description: z.string(),
    prompt: z.string(),
    subagent_type: z.enum(Object.keys(AGENT_REGISTRY) as [string, ...string[]])
  }),
  execute: async ({ prompt, subagent_type }) => {
    // 白名单校验：当前角色允许委派给谁
    if (!AGENT_REGISTRY[parentCtx.role].delegates.includes(subagent_type))
      return `Error: ${parentCtx.role} cannot delegate to ${subagent_type}`;
    return runAgent({                  // 递归调本节 §7 的 runAgent
      role: subagent_type,
      system: AGENT_REGISTRY[subagent_type].system,
      userPrompt: prompt,
      threadId: parentCtx.threadId,    // 子线程挂在主线程下，供 /subagent-messages 拉取
      depth: parentCtx.depth + 1
    });
  }
});
```

```ts
// ========== 4. 主 agent loop ==========
import { streamText, stepCountIs } from "ai";

async function runAgent(opts: {
  role: string;
  system: string;
  userPrompt: string;
  threadId: string;
  depth: number;
}) {
  const db = getDb();
  const model = resolveModel(db, opts.depth === 0 ? "chat" : "toolModel"); // 子代理用便宜模型
  const messages = loadHistory(db, opts.threadId);   // UIMessage[]
  messages.push({ id: nanoid(), role: "user", parts: [{ type: "text", text: opts.userPrompt }] });
  saveMessage(db, opts.threadId, messages.at(-1));

  const systemPrompt = assembleSystemPrompt({
    base: BASE_PROMPT,
    role: opts.system,
    catalog: AGENT_REGISTRY,                 // <managed_agent_catalog>
    skills: listSkillMetadata(db),           // <available_skills> 只 (name, desc)
    env: { cwd: process.cwd(), os: process.platform, date: new Date() },
    workspaceDocs: readIfExists(["CLAUDE.md", "AGENTS.md"]),
    userPrefs: getSettings(db).customInstructions
  });

  const tools = {
    ...builtinTools,
    Task: taskTool({ role: opts.role, threadId: opts.threadId, depth: opts.depth }),
    ...await loadMcpTools(db),               // mcp__<server>__<tool>
    ...await loadPluginTools(db)
  };

  const abort = new AbortController();
  registerAbortHandle(opts.threadId, abort); // 供 /ws stop_generation 调

  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: [stepCountIs(150)],            // 替代旧 maxSteps
    abortSignal: abort.signal,

    onChunk: async ({ chunk }) => {
      // 原样转发 AI SDK chunk —— 不改造，前端 useChat 直接消费
      wsBroadcast(opts.threadId, { type: "stream_chunk", chunk });
    },

    onFinish: async ({ response, usage, finishReason }) => {
      const assistantMsg = { id: nanoid(), role: "assistant", parts: response.messages.at(-1).parts };
      saveMessage(db, opts.threadId, assistantMsg);
      recordUsage(db, { threadId: opts.threadId, model: model.modelId, usage, finishReason });
      wsBroadcast(opts.threadId, { type: "message_added", message: assistantMsg });
      wsBroadcast(opts.threadId, { type: "generation_finished" });
    },

    onError: async ({ error }) => {
      wsBroadcast(opts.threadId, { type: "error", error: String(error) });
    }
  });

  await result.consumeStream();
  return (await result.text) ?? "";
}
```

```ts
// ========== 5. 审批闸门（包在工具外层）==========
const DANGEROUS = new Set(["Bash", "Write", "Edit", "MultiEdit", "ComputerUse*"]);

function withApproval(t: Tool, name: string, db): Tool {
  if (!DANGEROUS.has(name)) return t;
  return {
    ...t,
    execute: async (args, ctx) => {
      if (getSettings(db).security.autoApproveToolRequests) return t.execute(args, ctx);
      const ok = await askUserApproval({ tool: name, args });   // WS → 前端弹窗
      if (!ok) throw new Error("User denied");
      db.prepare("INSERT INTO approvals(tool,args,granted_at) VALUES(?,?,?)")
        .run(name, JSON.stringify(args), Date.now());
      return t.execute(args, ctx);
    }
  };
}
```

```ts
// ========== 6. Compact（压缩）==========
async function compactThread(threadId: string) {
  const db = getDb();
  const msgs = loadHistory(db, threadId);
  const toolModel = resolveModel(db, "toolModel");          // 用便宜模型做摘要
  const summary = await generateText({
    model: toolModel,
    prompt: `Summarize the following conversation, keep key facts/decisions/todos:\n\n${JSON.stringify(msgs)}`
  });
  // 插一条 system compact 消息，旧消息标记 archived（不删，留审计）
  db.prepare("UPDATE chat_messages SET archived=1 WHERE thread_id=?").run(threadId);
  saveMessage(db, threadId, {
    id: nanoid(),
    role: "system",
    parts: [{ type: "text", text: `[Compacted summary]\n${summary.text}` }]
  });
}
```

---

## 复刻优先级（按性价比排序）

| # | 必做 | 收益 |
|---|---|---|
| 1 | 直接用 Vercel AI SDK + `toUIMessageStreamResponse` chunk 协议 | 省自己造协议，前端 `useChat` 开箱即用 |
| 2 | `tool-overflow`（30 行代码） | 单条工具输出再也不会爆 context |
| 3 | 多模型槽位（至少 `chat` + `toolModel`） | 成本降 5-10x |
| 4 | 消息整存 JSON（UIMessage 序列化进 `message TEXT`） | 读写零转换 |
| 5 | `stopWhen: stepCountIs(N)` 替代手写 loop | agent loop 稳定可靠 |
| 6 | SKILL.md 三级渐进披露 | context 占用降一个数量级 |
| 7 | 危险工具审批闸门（一个高阶函数） | 安全兜底 |
| 8 | Compact 摘要 + `parent_id/slot_id/depth` 版本树 | 长会话可行 + 重新生成 |

---

## 附录：与既有文档的衔接

- 后端 schema / WS 协议 / REST 路由细节 → 见 `03-backend-api-database.md`
- Electron 桌面壳与 IPC → 见 `02-electron-desktop.md`
- 复刻路线图 → 见 `06-replication-roadmap.md`

【全文完】
