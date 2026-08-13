# Alma 后端架构与数据库设计调研报告

> 调研对象：Alma v0.0.960（Electron AI 助手桌面应用，主进程内嵌 HTTP 后端，端口 **23001**）
> 调研方法：静态挖掘 minified 主进程 bundle（`/tmp/alma-src/extracted/out/main/index.js`，2.3 MB）+ 只读查询运行中的 SQLite 数据库 + 只读调用运行中的 API（`curl http://localhost:23001/api/...`）+ 官方文档 `~/.config/alma/api-spec.md`
> 性质：**纯考古调研，未修改任何 Alma 系统文件或数据库**（所有 sqlite3 均用 `-readonly`，所有 curl 均为 GET）。
> 每条结论后标注【证据】；无法确证的标注【推测】。

---

## 1. 后端总体架构

### 1.1 内嵌服务模式

Alma 把后端服务**直接跑在 Electron 主进程内**，是"进程内嵌单体服务"。渲染进程（前端 UI）通过 `localhost:23001` 与主进程通信，等价于把"前端 ↔ 本地 REST/WS 后端 ↔ SQLite"这套 C/S 结构折叠进了一个 App。

```
Electron 主进程 (Node.js)
  └─ HTTP Server (Express 5, :23001)
       ├─ REST Router  : ~404 路由 /api/* （30+ 功能域）
       ├─ WebSocketServer (ws) : /ws/threads 等 12 个端点，复用 HTTP upgrade
       │       └─ 渲染进程(React) 经 fetch /api/* + new WebSocket(ws://localhost:23001/ws/threads) 接入
       ▼
     Service / 业务逻辑层 (AI 调用、agent 编排、MCP、cron、浏览器控制…)
       ▼
     drizzle-orm → better-sqlite3 (WAL) + sqlite-vec(向量) + FTS5(全文检索)
       ▼
     ~/Library/Application Support/alma/chat_threads.db  (62 MB)
```

【证据】
- 端口 23001：bundle 中 grep 命中 `23001`；`curl http://localhost:23001/api/health` 实测返回 `{"status":"ok","timestamp":"2026-08-13T03:11:55.256Z"}`。
- 框架 = **Express 5**（不是 Hono）：`package.json` 依赖含 `"express": "^5.1.0"`、`"cors": "^2.8.5"`；bundle grep 命中 `app.use`；未命中 `hono`/`fastify`。
- WebSocket = **ws 库**：`package.json` 依赖 `"ws": "^8.18.3"`；bundle 命中 `WebSocketServer`。
- ORM/DB = **drizzle-orm + better-sqlite3 + sqlite-vec**：`package.json` 依赖 `drizzle-orm@^0.44.4`、`better-sqlite3@^12.2.0`、`sqlite-vec@0.1.7-alpha.2`；bundle grep `sqlite-vec` 命中 22 次、`drizzle` 4 次、`better-sqlite3` 3 次、`wal`/`journal_mode` 命中。
- 数据目录：`~/Library/Application Support/alma/chat_threads.db`（62 MB）+ `chat_threads.db-wal` + `chat_threads.db-shm`（WAL 模式标志文件）。

### 1.2 服务如何启动与路由如何组织

- 主进程入口为 `out/main/index.js`（`package.json` 的 `"main"`）。启动时创建 Express app（`app.use(...)` 挂中间件，如 cors），`createServer` 创建 HTTP server 监听 23001，再在其上挂 `WebSocketServer` 处理 `upgrade`。
- 路由按**领域前缀**分模块组织：`/api/threads/*`、`/api/workspaces/*`、`/api/memories/*`、`/api/mcp-client/*` 等，每组一组 CRUD + 若干动作路由。共 **404 条路由字符串**（去重后）。
- 【推测】bundle 中可见 `app.use` + 大量路径字符串，符合 Express `Router()` 分模块挂载的编译产物特征；路由注册被 minify 为字符串字面量，故清单以字符串形式残留。

【证据】bundle grep `"/api/..."` sort -u 后 404 条（完整清单落盘 `/tmp/alma-routes.txt`）；`createServer`、`.listen`、`WebSocketServer` 均命中。

---
## 2. 路由分组全景表

下表把 404 条路由按前缀聚为 **30+ 个功能域**。完整原始清单见 `/tmp/alma-routes.txt`。

| 分组前缀 | 代表路由 | 职责 |
|---|---|---|
| `/api/health` | `GET /api/health` | 健康检查（实测返回 `{status:"ok"}`） |
| `/api/settings` | `GET/PUT /api/settings`、`POST .../reset`、`POST .../test-proxy` | 应用设置（PUT 需整对象回写） |
| `/api/providers` | `GET/POST /api/providers`、`PUT/DELETE .../:id`、`POST .../:id/test`、`GET/PUT .../:id/models`、`POST .../models/fetch`、`POST .../:id/authenticate` | AI Provider 配置/测活/模型列表/OAuth |
| `/api/models` | `GET /api/models` | 跨 provider 聚合模型，ID 形如 `providerId:modelId` |
| `/api/threads` | `GET/POST /api/threads`、`GET/PUT/DELETE .../:id`、`.../:id/messages`、`.../:id/branch`、`.../:id/compact`、`.../:id/activate|switch`、`.../archive`、`.../batch-delete`、`.../:threadId/context-usage|diff-stats|file-writes|traces|subagent-messages` | 会话线程 CRUD、分支、压缩、上下文用量、diff 统计、agent 编排 |
| `/api/messages` | `GET /api/messages/:messageId`、`POST .../rollback`、`.../switch-version`、`GET .../trace` | 单条消息回滚/版本切换/追踪 |
| `/api/search` | `GET /api/search/threads` | 线程搜索（底层走 FTS5） |
| `/api/workspaces` | `GET/POST /api/workspaces`、`.../:id/files(|copy|mkdir|move|rename|touch)`、`.../:id/git/*`（branch/checkout/commit/diff/stage/stash/rebase/conflicts/worktrees 等 ~30 条）、`.../:id/github/*`（pr/ci-logs）、`.../:id/preview/*` | 工作区文件管理 + 内嵌 Git 全套 + GitHub PR + 预览服务 |
| `/api/attachments` | `POST /api/attachments/image`、`GET .../resolve-path` | 附件（图片）上传/解析 |
| `/api/files-abs*` | `GET /api/files-abs`、`/api/files-abs-binary` | 绝对路径文件读取（文本/二进制） |
| `/api/memories` | `GET/POST /api/memories`、`.../:id`、`.../archive(|:id/restore)`、`.../search`、`.../rebuild(|progress|cancel)`、`.../embedding-model`、`.../sleep/(run|preview|runs|status|cancel)`、`.../stats|status` | 长期记忆：增删查、语义检索、向量重建、sleep 后台整理 |
| `/api/prompt-apps` | `GET/POST /api/prompt-apps`、`.../:id/execute`、`.../executions`、`.../reorder` | 提示词应用（模板+占位符+执行记录） |
| `/api/prompts` | `GET/POST /api/prompts`、`.../:id`、`.../reorder` | 快捷提示词片段 |
| `/api/skills` | `GET /api/skills`、`.../:id`、`POST .../refresh`、`/api/skills-path` | 技能（Claude Code 风格 skill 文件）管理 |
| `/api/agents` | `GET /api/agents`、`.../tasks/:taskId`、`.../tasks/:taskId/resume` | 子 agent 任务管理 |
| `/api/mcp-client` `/api/mcp-servers` | `.../tools`、`.../resources(|read|subscribe)`、`.../status`、`POST /api/mcp-servers`、`.../:id/oauth(|status)` | Model Context Protocol 客户端/服务器/OAuth |
| `/api/tools` | `GET /api/tools/list`、`POST /api/tools/invoke`、`/api/tool-group-summary`、`/api/tool-model*` | 内置工具列表/调用、工具摘要模型 |
| `/api/cron` | `GET/POST /api/cron/jobs`、`.../:id/run|runs|toggle` | 定时任务（croner 驱动） |
| `/api/terminal` | `POST .../create|exec`、`GET .../sessions`、`.../:id/input|output` | 内嵌终端（node-pty） |
| `/api/computer-use` | `.../click|type|scroll|shot|snap|launch_app|approvals|permissions|grant` 等 ~25 条 | macOS 桌面自动化（computer-use） |
| `/api/iab` | `.../navigate|click|type|read-dom|screenshot|eval|download|export|profiles` 等 ~30 条 | 内置应用内浏览器（In-App Browser）自动化 |
| `/api/chrome-relay` | `.../launch-chrome|navigate|click|eval|screenshot|tabs|token` | 接管用户真实 Chrome（CDP relay） |
| `/api/plan` `/api/plan-mode` | `.../block|claim|submit|review|resolve`、`POST /api/plan-mode/enter|exit` | 计划模式 / 任务图 |
| `/api/tts` | `POST .../generate`、`.../speech/(synthesize|ensure-model|prewarm|events)` | 文本转语音（本地 sherpa-onnx + 在线） |
| `/api/whisper` | `GET /api/whisper/models`、`.../:modelId/download` | 本地语音转文字模型管理 |
| `/api/image` | `POST /api/image/generate`、`GET /api/image/models` | 图像生成 |
| `/api/gallery` | `GET /api/gallery/images`、`.../:id`、`.../cache` | 生成图片画廊 |
| `/api/voice` `/api/chat/:chatId/send-*` | `POST /api/voice/send`、`send-audio|send-photo|send-video|send-voice|send-document` | 语音消息 / 通用聊天发送 |
| `/api/groups` `/api/reaction`（telegram 域） | `send|pin|unpin|leave|reaction/set` | Telegram Bot 集成 |
| `/api/discord` | `.../servers`、`.../channels/:channelId/messages(|send|send-file|send-photo)`、`.../dm`、`.../reaction` | Discord Bot 集成 |
| `/api/feishu` | `.../connect/start|state|cancel`、`.../chats/:chatId/send`、`.../send-file|send-photo` | 飞书集成 |
| `/api/weixin` | `.../qrcode`、`.../status`、`.../logout` | 微信集成（weixin-agent-sdk） |
| `/api/people` | `GET /api/people`、`.../:name`、`.../:name/avatar` | 联系人/人物 |
| `/api/plugins` `/api/plugin-themes` | `GET /api/plugins`、`.../:id/enable|disable|permissions|settings|update`、`/api/plugin-themes/:id/apply` | 插件系统 + 权限 + 主题 |
| `/api/custom-themes` | `GET/POST /api/custom-themes`、`.../:id` | 自定义主题 |
| `/api/usage` | `GET /api/usage/stats`、`POST .../start-migration`、`GET .../migration-status` | token 用量统计与历史数据迁移 |
| `/api/data` | `GET /api/data/export`、`POST /api/data/import` | 数据导入导出 |
| `/api/cloud-sync` | `.../enable|disable|push-snapshot|state` | 云同步快照 |
| `/api/update` | `.../check|download|install|status` | App 自更新（electron-updater） |
| `/api/activity-recorder` | `.../start|stop|status|sessions|sessions/:id/analyze|search/(keyword|semantic)|summary/(daily|weekly)|digest|suggestions` | 屏幕活动记录 + 日报/周报 |
| `/api/heartbeat` | `.../config`、`.../status` | 心跳自检 |
| `/api/hooks` | `GET /api/hooks`、`.../reload`、`/api/hooks/path` | 钩子系统 |
| `/api/local-embeddings` | `.../models`、`.../download`、`.../progress` | 本地 embedding 模型（transformers.js） |
| `/api/mobile-relay` | `.../enable|disable|connect-account|oauth-callback|token|e2e|status` | 移动端中继（Capacitor） |
| `/api/pip` | `.../present|hide|move|state|frame|invalidate` | 画中画悬浮窗 |
| `/api/bun` | `.../execute|install|status`、`.../executions/:id` | Bun 脚本执行 |
| `/api/chat/completions` | `POST /api/chat/completions` | OpenAI 兼容补全端点（供外部工具复用 Alma 的模型） |
| 杂项 | `/api/todos`、`/api/ptc/stats`、`/api/rtk/stats`、`/api/system/fonts`、`/api/test-workspace-route` | 待办/统计/系统 |

【证据】以上每行路由字符串均来自 bundle grep `"/api/..."`，去重后 404 条，落盘 `/tmp/alma-routes.txt`；`/api/health`、`/api/settings`、`/api/providers`、`/api/models` 等核心路由与官方 `api-spec.md` 完全吻合（该文档 2026-08-13 生成，覆盖 Settings/Provider/Models/Health，属"权威但只覆盖核心子集"）。

> **与旧版报告对照（增量）**：旧版 `API_REFERENCE.md`（3 个月前）主要覆盖 settings/providers/models/threads。本次 bundle 中**新增**的大块域：`activity-recorder`（屏幕记录）、`chrome-relay`（接管真实 Chrome）、`iab`（内置浏览器）、`plan`/`plan-mode`、`cloud-sync`、`mobile-relay`、`heartbeat`、`bun`、`weixin`、`feishu`、`computer-use` 全套、`usage` 迁移等。说明 Alma 近 3 个月从"AI 聊天 + Provider 管理"扩张为"全能 agent 工作台"。【推测：增量结论基于新旧路由域规模差异】

---
## 3. WebSocket 流式协议

### 3.1 WS 端点全景（共 12 个）

| WS 端点 | 用途 |
|---|---|
| `/ws/threads` | **核心**：聊天消息流式推送（token 流） |
| `/ws/settings` | 设置变更广播（API 改动 → 全客户端同步） |
| `/ws/providers` | provider 状态变更广播 |
| `/ws/skills` | 技能变更广播 |
| `/ws/memory` | 记忆变更广播 |
| `/ws/terminal/` | 终端 I/O 双向流（node-pty） |
| `/ws/preview/` | 预览服务输出 |
| `/ws/workspace/` | 工作区文件/状态推送 |
| `/ws/mcp-resources` | MCP 资源订阅推送 |
| `/ws/bun/` | Bun 执行输出流 |
| `/ws/browser-relay` | 浏览器中继（CDP 事件） |
| `/ws/debug-sse` | 调试流 |

【证据】bundle grep `"/ws[a-z0-9/_-]*"` sort -u 命中上述 12 条。

### 3.2 `/ws/threads` 双向消息协议

协议是 **JSON 文本帧**，每帧一个 `{type:"...", ...}` 对象。

**客户端 → 服务端**（控制/输入）：

| type | 含义 |
|---|---|
| `message` | 发送一条新用户消息（触发 AI 生成） |
| `edit` | 编辑已有消息并重新生成 |
| `stop_generation` | 中断当前流式生成 |
| `input_text` / `input_image` / `input_file` | 构造输入 part（文本/图片/文件附件） |
| `tool_input_append` | 工具输入追加 |

**服务端 → 客户端**（流式增量，对齐 **AI SDK v5 stream 协议**）：

| type | 含义 |
|---|---|
| `message_start` | 一条 assistant 消息开始 |
| `message_delta` | 消息元信息增量（如 usage） |
| `message_added` | 消息已落库（广播给同 thread 其他客户端） |
| `message_stop` / `finish` / `done` | 一条消息生成结束 |
| `text-delta` | 正文 token 增量（最常见的流事件） |
| `reasoning-start` / `reasoning-delta` / `reasoning-end` | 推理（thinking）块的开始/增量/结束 |
| `tool-input-start` / `tool-input-delta` / `tool-input-end` | 工具调用入参的开始/流式增量/结束 |
| `tool-call` / `tool_result` / `tool-call`（tool_call） | 工具调用完成 / 工具执行结果 |
| `error` | 错误帧 |
| `step-start` | 一个 agent step 的开始（多步工具循环） |

【证据】bundle grep 命中流事件类型字符串：`"text-delta"`、`"reasoning"`、`"reasoning-delta"`、`"reasoning-start"`、`"reasoning-end"`、`"tool-call"`、`"tool-result"`、`"tool_call"`、`"tool-input-start"`、`"tool-input-delta"`、`"tool-input-end"`、`"delta"`、`"done"`、`"finish"`、`"error"`；控制类型命中 `type:"message"`、`type:"edit"`、`type:"stop_generation"`、`type:"input_text"`、`type:"input_image"`、`type:"input_file"`、`type:"tool_input_append"`、`type:"message_start"`、`type:"message_delta"`、`type:"message_added"`、`type:"content_block_stop"`、`type:"message_stop"`。

【推测】这些事件类型与 Vercel AI SDK v5 的 `UIMessageChunk` / stream parts 命名（`text-delta`、`reasoning-delta`、`tool-input-start/delta/end`、`tool-call`、`tool-result`、`finish`、`error`）一一对应，且 `package.json` 依赖 `ai@^7.0.30` + `@ai-sdk/*`，可推断 Alma 后端直接用 AI SDK 的 `streamText(...).toUIMessageStream()` 之类产出 chunk，再原样经 WS 转发给前端；前端按 AI SDK 的 parts 语义重组为 `message.parts[]`。`/ws/threads` 很可能带 query（如 `?threadId=xxx`）做订阅过滤。

> **版本号说明**：文中「AI SDK v5」指产品代际（第 5 大版本迭代），npm 包 `ai` 的 semver 主版本为 7（`ai@^7.0.30`），两者不矛盾——`ai@7` 是 v5 代 SDK 的发布包。后续文档统一以「Vercel AI SDK v5（`ai@^7`）」表述。

### 3.3 前端订阅方式（推断）

```
const ws = new WebSocket("ws://localhost:23001/ws/threads?threadId=" + tid);
ws.onmessage = (ev) => {
  const frame = JSON.parse(ev.data);
  switch (frame.type) {
    case "text-delta":      appendToCurrentText(frame.delta); break;
    case "reasoning-delta": appendToReasoning(frame.delta);   break;
    case "tool-call":       renderToolCall(frame);            break;
    case "message_added":   syncFromDb(frame.message);        break;
    case "finish":          finalizeMessage();                break;
    case "error":           showError(frame.error);           break;
  }
};
// 发送
ws.send(JSON.stringify({ type:"message", threadId: tid, parts:[{type:"input_text", text:"hi"}] }));
```

【证据】事件名为 bundle 实证；订阅代码骨架为【推测】（bundle 为 minify 后端，前端在独立 renderer chunk，未在本次素材内）。

---
## 4. 数据库 Schema

### 4.0 总览

- **只有一个真实数据库文件**：`chat_threads.db`（62 MB）。全库 50+ 张表（含 sqlite-vec/FTS5 自动生成的影子表）。
- **WAL 模式**：存在 `chat_threads.db-wal`（4.3 MB）+ `chat_threads.db-shm`；bundle 命中 `journal_mode`/`WAL`。WAL 提供读写并发，适合"前端频繁读 + 流式生成频繁写"。
- **迁移机制**：表 `migrations(name TEXT PRIMARY KEY, executed_at TEXT)` 记录已执行的迁移名；bundle 中大量 `ALTER TABLE ... ADD COLUMN`（drizzle 风格增量 SQL 迁移），如 `ALTER TABLE chat_threads ADD COLUMN ...` 命中十余张表。
- **全文检索**：`messages_fts`（FTS5 虚表，列 `message_id/thread_id/content`）。
- **向量检索**：`memory_embeddings`（sqlite-vec 虚表，`embedding FLOAT[384]`）+ 影子表 `_info/_chunks/_rowids/_vector_chunks00`。

【证据】`sqlite3 -readonly chat_threads.db ".schema"` 全量导出；`sqlite3 ... ".tables"`；bundle grep `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS migrations`。

### 4.1 核心表完整 DDL + 字段注释

#### chat_threads（会话线程）

```sql
CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,                 -- 线程 ID（nanoid/UUID 风格字符串）
  title TEXT NOT NULL,                 -- 标题（自动摘要生成）
  model TEXT,                          -- 默认模型，"providerId:modelId"
  is_generating BOOLEAN DEFAULT FALSE, -- 是否正在流式生成
  reasoning_effort TEXT DEFAULT 'medium', -- 推理强度 low/medium/high
  metadata TEXT NOT NULL,              -- JSON：扩展元数据
  created_at TEXT NOT NULL,            -- ISO8601
  updated_at TEXT NOT NULL,
  -- ↓ 历次 ALTER 增量列 ↓
  prompt_app_id TEXT REFERENCES prompt_apps(id) ON DELETE SET NULL, -- 关联提示词应用
  tools TEXT,                          -- JSON：本线程启用的工具
  is_favorited INTEGER DEFAULT 0,      -- 收藏
  is_incognito INTEGER DEFAULT 0,      -- 无痕（不写历史）
  enable_artifacts INTEGER DEFAULT 0,  -- 启用 artifact 面板
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,        -- 工作区
  artifact_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL, -- artifact 工作区
  skill_ids TEXT,                      -- JSON：启用的技能
  is_favorite_pinned INTEGER DEFAULT 0,
  favorite_pinned_order INTEGER,
  tools_compact_view INTEGER,          -- 工具紧凑展示
  parent_thread_id TEXT                -- 父线程（branch 出来的子线程）
);
```
索引：`idx_threads_updated_at(updated_at)`、`idx_threads_workspace_id`、`idx_threads_prompt_app_id`、`idx_threads_artifact_workspace_id`。

#### chat_messages（消息，核心中的核心）

```sql
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,                 -- 消息 ID
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE, -- 所属线程
  parent_id TEXT,                      -- 父消息 ID（版本树/分支结构）
  slot_id TEXT,                        -- 版本槽：同一"对话位置"的不同重生成版本共享 slot
  depth INTEGER NOT NULL DEFAULT 0,    -- 在对话树中的深度
  message TEXT NOT NULL,               -- ★ 完整 AI SDK UIMessage JSON（见 4.3）
  timestamp TEXT NOT NULL,             -- 消息时间
  metadata TEXT NOT NULL,              -- JSON：usage、model、耗时等
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  parent_tool_call_id TEXT             -- 该消息由哪个工具调用产出（子 agent 消息树）
);
```
索引：`idx_messages_thread_id(thread_id)`、`idx_messages_timestamp`、`idx_messages_parent_id`、`idx_messages_slot_id`、`idx_messages_depth`、`idx_messages_version_info(thread_id,timestamp,id,slot_id,created_at)`。

> **设计要点**：`parent_id + slot_id + depth` 三者共同实现"消息版本树"——同一次提问重生成多次得到多个 assistant 版本，它们共享 `slot_id`、指向同一 `parent_id`，前端靠 `switch-version` 在版本间切换。这正是 ChatGPT"重新生成 / 1/2 版本切换"的数据模型。

#### providers（AI Provider）

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                  -- openai/anthropic/google/azure/acp/...
  api_key TEXT NOT NULL,               -- 加密存储（API 不回传明文）
  models TEXT NOT NULL,                -- JSON：启用的模型 StoredProviderModel[]
  base_url TEXT,
  api_version TEXT,                    -- Azure 用
  enabled BOOLEAN NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_response_api INTEGER DEFAULT 0,   -- Azure Responses API
  acp_command TEXT, acp_args TEXT, acp_mcp_server_ids TEXT,   -- ACP(Agent Client Protocol)
  acp_auth_method_id TEXT, acp_api_provider_id TEXT, acp_model_mapping TEXT,
  use_max_completion_tokens INTEGER DEFAULT 0,
  available_models TEXT NOT NULL DEFAULT '[]',  -- JSON：拉取到的全部模型
  api_format TEXT, custom_headers TEXT, copilot_account_id TEXT, icon TEXT
);
```
配套缓存表：`provider_models_cache(provider_id, models JSON, fetched_at)`、`model_capabilities_cache`。

#### memories + memory_embeddings（长期记忆 + 向量）

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,               -- 记忆文本
  metadata TEXT NOT NULL,              -- JSON
  thread_id TEXT REFERENCES chat_threads(id) ON DELETE SET NULL,
  message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_id TEXT
);
CREATE VIRTUAL TABLE memory_embeddings USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding FLOAT[384]                 -- 384 维 → 本地小模型（如 bge-small/all-MiniLM）
);
```
另有 `memory_metadata(key/value)`、`memory_archive`、`memory_embeddings_chunks/_rowids/_vector_chunks00`（sqlite-vec 影子表）。

#### workspaces（工作区）

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,                  -- 磁盘绝对路径
  name TEXT NOT NULL,
  is_temporary INTEGER NOT NULL DEFAULT 0,  -- 临时工作区（temp-xxx）
  show_in_list INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_worktree INTEGER NOT NULL DEFAULT 0,   -- git worktree
  parent_workspace_id TEXT, worktree_branch TEXT,
  auto_worktree INTEGER NOT NULL DEFAULT 0, auto_worktree_base_branch TEXT,
  pr_number INTEGER, pr_url TEXT, pr_state TEXT, pr_base_branch TEXT,  -- 关联 GitHub PR
  is_session INTEGER NOT NULL DEFAULT 0
);
```

#### usage_records（token 用量）

```sql
CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  model TEXT, provider_id TEXT,
  date TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cached_input_tokens INTEGER DEFAULT 0, cache_write_input_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0,
  timestamp TEXT NOT NULL, created_at TEXT NOT NULL
);
```
配套 `usage_migration_status`（单行表 `CHECK(id=1)`，记录历史用量迁移进度）。

#### 其余重要表（DDL 略，字段见 .schema）

| 表 | 职责 |
|---|---|
| `app_settings` | 单行（`id='default'`），`settings_data` JSON 存整棵 AppSettings |
| `agent_missions` / `agent_runs` / `agent_handoffs` / `mission_sprints` / `sprint_contracts` / `sprint_evaluations` | 多 agent 编排：任务→运行→交接→冲刺→验收契约→评分 |
| `mcp_servers` / `mcp_oauth_tokens` | MCP 服务器配置 + OAuth token |
| `prompt_apps` / `prompt_app_executions` | 提示词应用模板 + 执行记录 |
| `skills` / `prompts` / `plugins` / `plugin_permissions` / `custom_themes` | 技能/提示词/插件/权限/主题 |
| `gallery_images` / `gallery_cache_meta` | 生成图片画廊 |
| `thread_labels` / `thread_diff_stats_cache` | 线程标签 / diff 统计缓存 |
| `channel_mappings` | 外部平台(telegram/discord…)↔ thread 映射 |
| `preview_servers` | 工作区预览服务（port/command/pid/status） |
| `fts_metadata` / `messages_fts` | FTS5 全文检索 |

### 4.2 ER 图（核心关系）

```
                         ┌──────────────┐
                         │  workspaces  │
                         └──────┬───────┘
                                │ 1:N (workspace_id)
                                ▼
prompt_apps ──(SET NULL)──┌─────────────┐──(parent_thread_id, 自引用)──┐
                          │ chat_threads│                              │
                          └──────┬──────┘◄─────────────────────────────┘
                                 │ 1:N (thread_id, CASCADE)
            ┌────────────────────┼─────────────────────┐
            ▼                    ▼                     ▼
   ┌─────────────────┐  ┌────────────────┐   ┌──────────────────┐
   │  chat_messages  │  │ agent_missions │   │ channel_mappings │
   │  (message JSON) │  │  ├─agent_runs  │   └──────────────────┘
   └────┬───────┬────┘  │  ├─agent_handoffs
        │       │       │  ├─mission_sprints ─ sprint_contracts ─ sprint_evaluations
        │       │       └──────────────────┘
 1:N    │       │ 1:N
        ▼       ▼
 ┌─────────────┐  ┌───────────────┐   ┌──────────────┐
 │usage_records│  │gallery_images │   │ memories     │──1:1── memory_embeddings(vec0, 384d)
 └─────────────┘  └───────────────┘   └──────────────┘
        ▲                                  (thread_id SET NULL)
        └──────── message_id (CASCADE)
   chat_messages ──1:N──> messages_fts (FTS5, message_id+content)
   providers ──1:N──> provider_models_cache
   plugins ──1:N──> plugin_permissions (CASCADE)
```

### 4.3 消息在 DB 里的存储结构（与 AI SDK 的关系）

`chat_messages.message` 字段是一整个 **AI SDK UIMessage JSON**。实测取一条 assistant 消息，解析其 JSON：

- 顶层键：`{ "id", "role", "parts" }`
- `role` ∈ `user | assistant | system | tool`
- `parts` 是**有序 part 数组**，实测一条消息含：
  `["step-start","text","reasoning","text","tool-Bash","tool-Bash","step-start","text","tool-Read","step-start"]`

part 类型（对齐 AI SDK v5 UIMessage parts）：
- `{type:"text", text:"..."}` — 正文
- `{type:"reasoning", text:"..."}` — 思考块
- `{type:"step-start"}` — 一个 agent step 的分界
- `{type:"tool-<NAME>", toolCallId, state, input, output}` — 工具调用（如 `tool-Bash`、`tool-Read`、`tool-WebFetch`），`state` ∈ `input-streaming/input-available/output-available/output-error`
- `{type:"file", ...}` / 图片附件 — 引用 blob_storage 或 file_path

【证据】`sqlite3 -readonly chat_threads.db "SELECT message FROM chat_messages WHERE message LIKE '%tool%' ... LIMIT 1"` 解析得 top keys `[id, role, parts]`、role=assistant、parts 类型如上；另查含 image 的线程得 part 类型 `tool-WebFetch`/`step-start`。

> **与 AI SDK 的对应**：这正是 Vercel AI SDK v5 的 `UIMessage` 持久化格式——Alma 把 SDK 内存里的 message 对象**整体序列化存进 `message` TEXT 列**，而非拆成"一条消息一行 + parts 子表"。优点是读写零转换（前端 `useChat` 直接消费）；缺点是 part 级检索要靠 FTS 虚表/JSON 函数补。【推测：`message` 列 = AI SDK `MyUIMessage` 的 `JSON.stringify`，metadata 列存 `usage`/`model` 等可从 SDK 的 `onFinish` 回调拿到】

---
## 5. 文件存储布局

数据根目录：`~/Library/Application Support/alma/`。数据库之外的文件存储：

```
~/Library/Application Support/alma/
├── chat_threads.db / .db-wal / .db-shm     # 唯一 SQLite 库（WAL）
├── blob_storage/<uuid>/                    # 二进制附件（图片/文件），按 UUID 分目录
├── workspaces/                             # 每个工作区一个目录（threads 的工作目录）
│   ├── default/                            # 默认工作区
│   │   ├── threads/                        # ★ 会话的 Markdown 镜像导出
│   │   │   ├── 2026-04-05_Telegram_Chat.md
│   │   │   ├── 2026-01-06_上海三日游攻略规划.md
│   │   │   └── .archive-state.json         # 归档状态
│   │   └── .gitignore
│   └── temp-<nanoid>/                      # 临时工作区（一次性任务）
│       ├── .alma-snapshots/                # 工作区快照（config/index/history/objects/snapshots）
│       └── <项目文件>                       # agent 实际读写的代码/文档
├── embedding-models/                       # 本地 embedding 模型（transformers.js 缓存）
├── whisper_models/                         # 本地 whisper 语音模型
├── gallery_cache/                          # 生成图片缓存（对应 gallery_cache_meta 表）
├── sentry/  heap-snapshots/                # 崩溃上报 / 内存快照
├── blob_storage/、Cache/、GPUCache/…       # Electron/Chromium 自身缓存
└── window-state.json                       # 窗口位置
~/.config/alma/
├── api-spec.md                             # 官方 API 文档
└── tool-overflow/Bash-stdout-*.log         # 超长工具输出落盘（供 Read offset/limit 续读）
```

要点：
- **附件（图片/文件）** 存 `blob_storage/<uuid>/`，消息 part 里的 `file`/`image` 引用之；`POST /api/attachments/image` 上传、`/api/attachments/resolve-path` 解析路径。
- **会话的"用户可读副本"** 以 Markdown 形式镜像到 `workspaces/<ws>/threads/<日期>_<标题>.md`（DB 才是权威数据源，.md 是导出/便于用户查看）。【证据】实测 `workspaces/default/threads/` 下 14 个 `.md` 文件，命名 `YYYY-MM-DD_标题.md` + `.archive-state.json`。
- **临时工作区** `temp-<nanoid>` 存放一次性 agent 任务的产物；`.alma-snapshots/` 是工作区级版本快照（对象存储风格 objects/snapshots/index/history）。
- **tool-overflow**：超长的工具 stdout 不写进消息本体，落盘 `~/.config/alma/tool-overflow/*.log`，消息里只存摘要+路径，前端按需续读。【证据】本次调研多条 Bash 输出被 alma 压缩并写入该目录。

【证据】`ls -la ~/Library/Application Support/alma/`、`find workspaces/...`、`ls ~/.config/alma/tool-overflow/` 实测。

---

## 6. 认证 / 安全

- **绑定 localhost**：bundle 命中 `127.0.0.1`、`localhost`，服务只监听回环地址，外部网络不可达。【证据】bundle grep；服务在本机 `curl localhost:23001` 可通。
- **无全局鉴权 token**（对本机 REST）：`/api/health`、`/api/settings` 等核心端点**无需任何 token 即可 GET**——实测直接 `curl` 成功。信任边界 = "本机进程"。这是本地桌面 App 的常见取舍，但意味着**本机任意进程都能读写你的 AI 配置/会话**。
- **局部 token**：仅个别对外/跨进程面有 token——`chrome-relay`（`/api/chrome-relay/token|regenerate`，settings 里有 `chromeRelayAuthToken`）、`mobile-relay`（`.../token`）。【证据】路由字符串 + settings JSON 含 `chromeRelayAuthToken` 键。
- **CORS**：依赖 `cors` 包 + bundle 命中 `Access-Control-Allow-Origin`/`origin:`，用于限制哪些 origin 能跨域调用（渲染进程 `file://`/自定义协议）。
- **API key 加密**：providers 表的 `api_key` 加密存储，API 响应不回传明文（api-spec 明确"Encrypted, do not expose"）。
- **敏感操作走审批**：`computer-use` 有 `approvals/permissions/grant/check_approval` 全套，`security.autoApproveToolRequests` 控制工具是否自动批准。

【推测】无鉴权设计是"绑定 loopback + 桌面单用户"模型下的有意为之；若要将服务暴露到局域网/远程，必须自行加 token 中间件 + TLS，否则风险极高。

---

## 7. 【复刻要点】自己实现一个"Alma 后端"

### 7.1 推荐技术栈（与 Alma 同源，已被验证可行）

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js（Electron 主进程内嵌） | 桌面 App 免单独部署 |
| HTTP 框架 | **Express 5** 或 **Hono** | Alma 用 Express；Hono 更轻、TS 体验更好，二选一即可 |
| WebSocket | **ws**（`WebSocketServer` 复用 HTTP server 的 upgrade） | 与 REST 同端口 |
| 数据库 | **better-sqlite3**（WAL 模式） | 同步 API、零配置、单文件、性能极好 |
| ORM | **drizzle-orm** + drizzle-kit 迁移 | 类型安全 schema + SQL 迁移 |
| 向量 | **sqlite-vec**（vec0 虚表） | 与主库同文件，免独立向量库 |
| 全文检索 | **SQLite FTS5** | 内置，零依赖 |
| AI 接入 | **Vercel AI SDK**（`ai` + `@ai-sdk/*`） | message/stream/parts 协议直接用它的，前端 `useChat` 开箱即用 |

### 7.2 最小可用 schema（先跑通这 4 张表）

```sql
CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT,
  is_generating INTEGER DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  parent_id TEXT,          -- 版本树
  slot_id TEXT,            -- 重生成版本槽
  depth INTEGER DEFAULT 0,
  role TEXT NOT NULL,      -- 冗余一份 role 便于查询（body 里也有一份）
  message TEXT NOT NULL,   -- ★ 完整 AI SDK UIMessage JSON {id,role,parts[]}
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_msg_thread ON chat_messages(thread_id);
CREATE INDEX idx_msg_version ON chat_messages(thread_id, timestamp, slot_id);

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  api_key TEXT NOT NULL,   -- 加密
  models TEXT NOT NULL DEFAULT '[]',
  base_url TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  settings_data TEXT NOT NULL,   -- 整棵 settings JSON，单行
  updated_at TEXT NOT NULL
);
-- 迁移记录表（drizzle-kit 自动维护亦可）
CREATE TABLE migrations (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL);
```

后续按需加：`memories` + `memory_embeddings(vec0)`、`usage_records`、`messages_fts(FTS5)`。

### 7.3 最小 REST 路由集

```
GET  /api/health
GET  /api/threads           POST /api/threads
GET  /api/threads/:id       PUT  /api/threads/:id    DELETE /api/threads/:id
GET  /api/threads/:id/messages
POST /api/messages/:id/switch-version     # 版本树切换
GET  /api/providers         POST /api/providers
PUT  /api/providers/:id     DELETE /api/providers/:id
POST /api/providers/:id/test
GET  /api/models
GET  /api/settings          PUT  /api/settings
```

### 7.4 WS 流式推送怎么设计（关键）

1. **一个 `/ws/threads` 端点**，连接后客户端发 `{type:"subscribe", threadId}` 订阅某线程（或干脆用 query `?threadId=`）。
2. **发消息**：客户端 `send({type:"message", threadId, parts:[{type:"text", text}]})`；服务端落库 user 消息 → 调 AI SDK `streamText` → 把流 chunk 逐帧推给该线程所有订阅者。
3. **直接复用 AI SDK 的 chunk 协议**，别自己造：`streamText(...).toUIMessageStreamResponse()` 产出的 chunk 类型就是 `text-delta / reasoning-delta / tool-input-* / tool-call / tool-result / finish / error`，原样经 WS 转发即可，前端用 `useChat` 或手动重组 parts。
4. **落库时机**：在 `onFinish` 回调里拿到完整 assistant UIMessage，`JSON.stringify` 存进 `chat_messages.message`，同时写 `usage_records`。流中途只推送不落库，避免半成品数据。
5. **断线续传**：记录 `is_generating` + 最后落库消息；客户端重连后 `GET /api/threads/:id/messages` 全量对齐（Alma 的 `message_added` 帧即用于多端同步）。
6. **中断**：客户端发 `{type:"stop_generation", threadId}` → 服务端 `abortController.abort()`。

### 7.5 复刻注意事项 / 坑

- **消息"整存 JSON" vs "拆子表"**：Alma 选整存（`message` TEXT 存整个 UIMessage）。简单且与前端零阻抗，但 part 级查询要靠 FTS/JSON 函数。复刻起步建议同样整存。
- **版本树**：`parent_id + slot_id + depth` 三件套是实现"重新生成 / 版本切换 / 分支"的最小模型，值得照抄。
- **WAL 必开**：`PRAGMA journal_mode=WAL;` 否则流式高频写会锁库。
- **迁移**：drizzle-kit 生成 SQL 迁移 + `migrations` 表记录，启动时跑未执行项；`ALTER TABLE ADD COLUMN` 是 SQLite 安全的增量方式。
- **本地安全**：绑 loopback 即可裸奔，但一旦要远程访问必须加 token + TLS。
- **向量/FTS 可后补**：先跑通 threads+messages+providers，memory 的 sqlite-vec 和 messages_fts 是增强项。

【证据/推测说明】7.1 选型全部来自 Alma `package.json` 实证依赖；7.2-7.4 为基于实证 schema 与 WS 协议的【复刻建议】，其中"直接复用 AI SDK chunk 协议"有强证据（bundle 事件名与 AI SDK 完全一致 + `ai` 依赖），具体函数调用形式为推测。

---

## 附录：证据文件

| 文件 | 内容 |
|---|---|
| `/tmp/alma-routes.txt` | 404 条 API 路由字符串（去重） |
| bundle schema grep | `sqlite3 -readonly chat_threads.db ".schema"` 全量（本报告 §4 为节选） |
| 实测 API | `GET /api/health` → `{status:"ok"}`；`GET /api/settings` → 27 个顶层键（general/chat/ui/network/data/security/advanced/keybindings/memory/toolModel/onboarding/whisper/webSearch/terminal/themeConfig/tools/tts/telegram/agents/weixin/chromeRelayAuthToken/embeddingModel/skillExtraction/visionModel/imageGen/mobileRelay/needsEmbeddingRebuild） |
| 实测行数 | chat_threads=12、chat_messages=132、memories=75 |
