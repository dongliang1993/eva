# 18. Alma v0.0.990 数据库 Schema 全集

> 基线版本：Alma v0.0.990（2026-08-21 构建）。证据来源：`/tmp/alma-extract/main.readable.js`（下文简称 bundle，行号即该文件行号）与 `/tmp/alma-extract/tables-all.sql`（已提取的建表原文）。本文是对旧版 03 篇 §4 的全量替换式更新——**逐表对照差异，并给出直接可照抄的 SQL 原文**。
>
> 最重要的三个结论先行：
> 1. **仍然只有一个主库 `chat_threads.db`**，全部 53 张 CREATE TABLE + 4 张虚拟表（vec0 / FTS5）都落在它上面；
> 2. **迁移机制是「CREATE IF NOT EXISTS 建基线 + 78 条裸 `ALTER TABLE`（try/catch 吞错）补列 + 少数 `migrations` 表记账的数据迁移 + `PRAGMA table_info` 检测式重建」的混合体**，没有任何正经 migration runner；
> 3. **记忆检索是纯 vec0 余弦 KNN，没有 RRF/BM25 混合检索**（旧版 05 篇 §2 的「混合检索」论断在 v0.0.990 不成立）；FTS5 虚表 `messages_fts` 只服务历史消息关键词搜索，且分词是**入库前用 jieba-wasm 预切词后写空格分隔文本**，不是 FTS5 tokenizer。

---

## 1. 数据库文件清单

grep 全 bundle 的 `.db` 字符串（`main.readable.js:2685/24829/57110/75148/104719`）：

| 文件 | 位置 | 用途 |
|---|---|---|
| `chat_threads.db` | `app.getPath("userData")`（打包态 `~/Library/Application Support/alma/`） | **唯一主库**，本文全部表都在里面（`:2685` `this.dbPath = Y.join(e, "chat_threads.db")`） |
| `rtk-tracking.db` | 平台数据目录（win `%APPDATA%/alma`，其余 `~/.local/share/alma`）（`:24829`） | RTK 屏幕时间追踪 sidecar 自己的库，bundle 内无其建表语句 |
| `alma-history-${pid}-${source}.db` / `alma-cookie-import-${pid}-${source}.db` | tmp（`:75148`、`:104719`） | 浏览器历史/cookie 导入时的临时副本 |

主库连接参数（`:2691-2696`，better-sqlite3 `pragma`）：

```js
e.pragma("journal_mode = WAL");   e.pragma("busy_timeout = 5000");
e.pragma("foreign_keys = ON");    e.pragma("synchronous = NORMAL");
e.pragma("cache_size = -64000");  e.pragma("temp_store = MEMORY");
```

ORM 为 **drizzle-orm/better-sqlite3**（`:100/112/118`：`drizzle-orm/better-sqlite3`、`drizzle-orm`、`drizzle-orm/sqlite-core` 的 import；`sqliteTable as ue` 在 `:115`）。sqlite-vec 扩展从 `app.asar.unpacked/node_modules/sqlite-vec-{platform}-{arch}/vec0.{dylib|dll|so}` 加载，fallback 到 `require("sqlite-vec").getLoadablePath()`（`:1684-1766`）。

建表分三处执行：

1. `DatabaseService.createTables()`（`:2742-3452`）——主库 46 张普通表 + `messages_fts` 相关，外加绝大部分 ALTER 迁移；
2. `MemoryService.createTables()`（`:1787-1847`）——记忆域 4 张普通表 + `memory_embeddings` vec0 虚表（由 `initializeMemoryAndEmbeddings` 在主库建表后调用，`:2702`）；
3. drizzle `sqliteTable()` 定义（`ue(...)`，全 bundle 36 处，`:729-1550`）——**查询侧的真值来源**；其中 `plugin_state`（`:1444`）只有 drizzle 定义、bundle 里没有对应 CREATE TABLE，属运行时依赖表已存在。

---

## 2. 表目录总表

「旧版」指旧版 03 篇 §4 已记录的表。SQL 原文见 `/tmp/alma-extract/tables-all.sql`，本文 §3/§4 引用。

| 表名 | 库 | 用途 | 旧版 |
|---|---|---|---|
| `chat_threads` | chat_threads.db | 会话线程（标题/模型/metadata，ALTER 后含 workspace、收藏、无痕、skill_ids 等 20+ 列） | 旧版已有，新增 `parent_thread_id` 等 ALTER 列，见 §3.1 |
| `chat_messages` | chat_threads.db | 消息（UIMessage 整包 JSON + parent_id/slot_id/depth 版本树） | 旧版已有，新增 `parent_tool_call_id` 列 |
| `messages_fts` (FTS5 虚表） | chat_threads.db | 历史消息关键词搜索（jieba 预分词） | 旧版已有，分词从「空格」升级为 jieba（version 6 重建） |
| `fts_metadata` | chat_threads.db | FTS 重建水位（key='version'） | 旧版已有 |
| `app_settings` | chat_threads.db | 单行（`id='default'`）整棵 AppSettings JSON | 旧版已有 |
| `providers` | chat_threads.db | AI Provider 配置（18 种 type 枚举，ALTER 后 24 列） | 旧版已有，见 §3.8 |
| `provider_models_cache` | chat_threads.db | 各 provider 拉取到的模型列表缓存 | 旧版已有 |
| `model_capabilities_cache` | chat_threads.db | 模型能力（vision/tools…）缓存 | 旧版已有 |
| `memories` | chat_threads.db | 长期记忆正文 + metadata JSON | 旧版已有，新增 `user_id` 列（§3.3） |
| `memory_embeddings` (vec0 虚表） | chat_threads.db | 记忆向量，`FLOAT[1536]`（随模型动态重建） | 旧版已有，**384→1536 默认维度翻转**（§6.2） |
| `memory_metadata` | chat_threads.db | 记忆 KV（当前记 `embedding_model`） | 旧版已有 |
| `memory_archive` | chat_threads.db | 记忆归档（软删除可追溯/可还原） | 旧版已有 |
| `memory_sleep_runs` | chat_threads.db | 后台记忆整理运行记录 + token 计量 | 旧版已有，新增 token 两列（§3.3） |
| `agent_missions` | chat_threads.db | 多 agent 任务（目标/状态/共享摘要，ALTER 后含 harness/sprint 列） | 旧版已有，见 §3.4 |
| `agent_runs` | chat_threads.db | agent 运行实例（task_id UNIQUE，树状 parent_run_id） | 旧版已有 |
| `agent_handoffs` | chat_threads.db | agent 间交接（packet JSON） | 旧版已有 |
| `mission_sprints` | chat_threads.db | 任务冲刺 | 旧版已有 |
| `sprint_contracts` | chat_threads.db | 冲刺验收契约（criteria JSON，版本化） | 旧版已有 |
| `sprint_evaluations` | chat_threads.db | 冲刺评分（grades JSON + overall_passed） | 旧版已有 |
| `agent_op_traces` | chat_threads.db | 单次模型 turn 的运行观测（token 六元组 + 结束原因归一化） | 🆕 |
| `agent_op_trace_steps` | chat_threads.db | turn 内逐 step 观测（call_llm/call_tool） | 🆕 |
| `mcp_servers` | chat_threads.db | MCP 服务器配置 | 旧版已有 |
| `mcp_oauth_tokens` | chat_threads.db | MCP OAuth2.1 token（含 code_verifier；经历过重建去 FK） | 旧版已有，结构以 §3.8 为准 |
| `workspaces` | chat_threads.db | 工作区（ALTER 后含 worktree/PR/remote_host 等 17 列） | 旧版已有，见 §3.5 |
| `preview_servers` | chat_threads.db | 工作区预览服务（port/command/pid/status） | 旧版已有 |
| `remote_hosts` | chat_threads.db | SSH 远程主机（配合 workspaces.remote_host_id） | 🆕 |
| `prompt_apps` | chat_threads.db | 提示词应用模板（ALTER 后含窗口尺寸/字体等 8 列） | 旧版已有，见 §3.6 |
| `prompt_app_executions` | chat_threads.db | 提示词应用执行记录 | 旧版已有 |
| `prompts` | chat_threads.db | 快捷提示词片段 | 旧版已有 |
| `skills` | chat_threads.db | 技能启用状态与排序（path 指向磁盘 SKILL.md） | 旧版已有 |
| `plugins` | chat_threads.db | 插件清单（manifest JSON） | 旧版已有 |
| `plugin_permissions` | chat_threads.db | 插件权限（UNIQUE(plugin_id, permission)） | 旧版已有 |
| `plugin_state` | chat_threads.db | 插件 KV 状态（仅 drizzle 定义，`:1444`） | 🆕 |
| `custom_themes` | chat_threads.db | 自定义主题（base_30/base_16 两套色板 JSON） | 旧版已有 |
| `thread_labels` | chat_threads.db | 线程标签定义 | 旧版已有 |
| `thread_diff_stats_cache` | chat_threads.db | 线程 diff 统计缓存 | 旧版已有 |
| `tool_group_summaries` | chat_threads.db | 工具组摘要缓存（segment_key 主键） | 旧版已有 |
| `channel_mappings` | chat_threads.db | 外部平台（telegram/discord/feishu/lark/weixin）↔ thread 映射 | 旧版已有 |
| `usage_records` | chat_threads.db | token 用量流水（五元组 + cache_write） | 旧版已有 |
| `usage_migration_status` | chat_threads.db | 单行（CHECK id=1）用量迁移进度 | 旧版已有 |
| `gallery_images` | chat_threads.db | 生成图片画廊索引 | 旧版已有 |
| `gallery_cache_meta` | chat_threads.db | 画廊缓存 schema 版本（`:4131`） | 旧版已有 |
| `reference_links` | chat_threads.db | `alma://` 引用图谱边（from_uri→to_uri） | 🆕 |
| `reference_snippets` | chat_threads.db | 引用片段（text_hash 去重） | 🆕 |
| `activity_sessions` | chat_threads.db | 屏幕活动会话（分析状态机 + 实体/主题/高光） | 🆕 |
| `activity_events` | chat_threads.db | 活动事件流（点击/按键/前台切换/浏览器访问…） | 🆕 |
| `activity_snapshots` | chat_threads.db | 截屏快照（去重 hash + 直方图 + diff_pct） | 🆕 |
| `activity_ocr_frames` | chat_threads.db | OCR 文本帧（embedding 为 BLOB，非 vec0） | 🆕 |
| `activity_summaries` | chat_threads.db | 日/周摘要（UNIQUE(kind, date_key)） | 🆕 |
| `computer_use_app_approvals` | chat_threads.db | 桌面自动化按 bundle_id 的授权记忆 | 🆕 |
| `computer_use_action_log` | chat_threads.db | 桌面自动化动作审计日志 | 🆕 |
| `migrations` | chat_threads.db | 已执行迁移名记账（name PK, executed_at） | 旧版已有 |

合计 53 张普通表（52 张 CREATE TABLE 原文 + 1 张仅 drizzle 定义的 `plugin_state`）+ 2 张虚表（`memory_embeddings`、`messages_fts`）+ vec0/FTS5 影子表若干。bundle 中 `CREATE TABLE` 命中 53 处、`CREATE VIRTUAL TABLE` 命中 4 处（vec0 的 1536 初建 + 两处动态维度重建 + fts5）、`CREATE INDEX` 命中 83 处、`ALTER TABLE` 命中 78 处。

---

## 3. 核心表完整 SQL + 逐列注释

### 3.1 chat_threads（会话线程）

CREATE 原文（`:2745`）：

```sql
CREATE TABLE IF NOT EXISTS chat_threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT,
    is_generating BOOLEAN DEFAULT FALSE,
    reasoning_effort TEXT DEFAULT 'medium',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

CREATE 只是**历史基线**。终态 = 基线 + 13 条 ALTER（`:3164-3254`），逐列注释以 drizzle 终态（`:815-860`）为准：

| 列 | 类型/默认 | 含义 |
|---|---|---|
| `id` | TEXT PK | 线程 ID |
| `title` | TEXT NOT NULL | 标题（自动生成） |
| `model` | TEXT | 默认模型，`providerId:modelId` 形式 |
| `is_generating` | BOOLEAN DEFAULT FALSE | 正在流式生成标志 |
| `reasoning_effort` | TEXT DEFAULT 'medium' | 推理强度 low/medium/high |
| `metadata` | TEXT(json) DEFAULT '{}' | 扩展元数据；**活动路径 `activePath` 就存在这里**（见 3.2） |
| `tools` | TEXT(json) | 本线程启用的工具集（ALTER `:3207`） |
| `tools_compact_view` | INTEGER(boolean) | 工具块紧凑展示（ALTER `:3249`） |
| `prompt_app_id` | TEXT → prompt_apps(id) SET NULL | 由哪个提示词应用创建（ALTER `:3169`） |
| `workspace_id` | TEXT → workspaces(id) SET NULL | 绑定工作区（ALTER `:3236`） |
| `artifact_workspace_id` | TEXT → workspaces(id) SET NULL | artifact 面板独立工作区（ALTER `:3241`） |
| `is_favorited` / `is_favorite_pinned` / `favorite_pinned_order` | INTEGER(boolean) / INTEGER | 收藏 / 置顶 / 置顶顺序（ALTER `:3211/3221/3226`） |
| `is_incognito` | INTEGER(boolean) DEFAULT 0 | 无痕模式（不写记忆、不进检索，`:3216`） |
| `enable_artifacts` | INTEGER(boolean) DEFAULT 0 | 启用 artifact 面板（`:3231`） |
| `parent_thread_id` | TEXT | branch 出来的父子线程关系（`:3254`） |
| `skill_ids` | TEXT(json) | 本线程启用的技能（`:3245`） |
| `created_at` / `updated_at` | TEXT NOT NULL | ISO8601 |

索引：`idx_threads_updated_at(updated_at)`、`idx_threads_prompt_app_id`、`idx_threads_workspace_id`、`idx_threads_artifact_workspace_id`（`:2977, 3385-3396`）。

### 3.2 chat_messages（消息 + 版本树）

CREATE 原文（`:2748`）：

```sql
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    parent_id TEXT,
    slot_id TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
)
```

逐列注释（终态 = 基线 + `parent_tool_call_id`（ALTER `:3159`），drizzle 见 `:861-881`）：

| 列 | 含义 |
|---|---|
| `id` | 消息 ID |
| `thread_id` | 所属线程，CASCADE 级联删 |
| `parent_id` | **版本树父指针**：树状对话结构（ALTER `:3147` 补入，晚于 CREATE 存在说明该表历史上重建过） |
| `slot_id` | **版本槽**：同一对话位置的多个重生成版本共享同一 slot_id（`NULL` 时以 `id` 自身为槽，见 `:4540` `l.slotId || l.id`） |
| `depth` | 树中深度（ALTER `:3154`） |
| `parent_tool_call_id` | 该消息由哪个工具调用产出（子 agent 消息树的挂载点；有这些值的消息在主线渲染时被过滤，`:4465` `.filter((e) => !e.parentToolCallId)`） |
| `message` | **完整 AI SDK UIMessage JSON**（drizzle `mode:"json"`），角色/parts/工具调用全在里面 |
| `timestamp` | 消息时间（排序键，`idx_messages_timestamp`） |
| `metadata` | JSON：usage、model、耗时等 |
| `created_at` / `updated_at` | ISO8601 |

索引（`:2971-2976`）：

```sql
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON chat_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON chat_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_version_info ON chat_messages(thread_id, timestamp, id, slot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON chat_messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_slot_id ON chat_messages(slot_id);
CREATE INDEX IF NOT EXISTS idx_messages_depth ON chat_messages(depth);
```

**版本树工作原理（复刻要点）**：`parent_id + slot_id + depth` 三列构成「每个对话位置一棵树」。活动视图不实时算，而是把当前选中的消息 ID 链存进 `chat_threads.metadata.activePath`（`:4441-4449`）。`getThreadWithMessages` 里的重建逻辑（`:4451-4526`）：按 `parentId` 分组孩子 → 同 slot 内若只有 1 条直接选，多条则优先选 `activePath` 里已有的，否则选 `createdAt` 最新（`:4478-4500`）；重建出的链与原 `activePath` 不一致时写回并打 `u: !0` 标记。`idx_messages_version_info` 复合索引就是为这条「按 thread 取 (timestamp,id,slot_id,created_at)」的查询服务的（`:2973`）。

### 3.3 记忆域（memories 家族，5 张表）

全部由 `MemoryService.createTables()` 建（`:1787-1847`），与主库同文件。

**memories**（`:1790`）：

```sql
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL,
    thread_id TEXT REFERENCES chat_threads(id) ON DELETE SET NULL,
    message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

ALTER 增量（`:1831-1842`，PRAGMA 检测式）：

```js
this.sqlite.prepare("PRAGMA table_info(memories)").all()
    .some((e) => "user_id" === e.name) ||
(this.sqlite.exec("ALTER TABLE memories ADD COLUMN user_id TEXT"),
 this.sqlite.exec("CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id)"),
 console.log("[MemoryService] Migrated: added user_id column to memories"));
```

| 列 | 含义 |
|---|---|
| `id` | 记忆 ID |
| `content` | 记忆正文 |
| `metadata` | JSON：`{source: "manual"|"auto", tags: string[], importance: 0-1, accessCount, durability: "permanent"|"temporary", expiresAt?, lastAccessedAt?, rationale?, activitySource?, activitySessionId?}` |
| `thread_id` | 来源线程，SET NULL（线程删除不影响记忆） |
| `message_id` | 来源消息 |
| `user_id` | **多租户命名空间**，形如 `telegram:123`（渠道映射合成；检索/归档按它隔离） |

索引：`idx_memories_thread_id / idx_memories_created_at / idx_memories_updated_at / idx_memories_user_id`（`:1805-1807, 1838`）。

**memory_embeddings**（vec0 虚表，`:1793`）：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
    memory_id TEXT PRIMARY KEY,
    embedding FLOAT[1536]
)
```

> **维度不是常量**。`1536` 只是新建库默认（对齐 `text-embedding-3-small`）；`ensureVectorTableDimensions(n)` 在表为空时 DROP 重建为任意维度（`:1848-1860`），切模型走 `rebuildEmbeddings` 全量重算（见 §6.2）。本地 transformers.js 384 维模型会把表建成 `FLOAT[384]`。

**memory_metadata**（`:1796`）：

```sql
CREATE TABLE IF NOT EXISTS memory_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
```

当前只记一个 key：`embedding_model`（`getStoredEmbeddingModel`/`setStoredEmbeddingModel`，`:1861-1878`），用于检测 embedding 模型漂移（`hasEmbeddingModelChanged`，`:1880`）。

**memory_archive**（`:1799`）：

```sql
CREATE TABLE IF NOT EXISTS memory_archive (
    id TEXT PRIMARY KEY,
    original_id TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL,
    thread_id TEXT,
    message_id TEXT,
    user_id TEXT,
    original_created_at TEXT NOT NULL,
    original_updated_at TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    archived_reason TEXT NOT NULL,
    archived_by TEXT NOT NULL,
    merged_into TEXT
)
```

软删除表：`archiveMemory` 把整行拷进来再删原行（`:2357-2380`），`restoreFromArchive` 可还原（`:2386-2398`）。`archived_reason` 取值对应 sleep 四层：`exact_dup | expired | orphan | similarity_merge | llm_merge`；`archived_by` 记发起方（sleep runId 或 manual）；`merged_into` 指向合并幸存者的 memory id。索引：`idx_memory_archive_archived_at(DESC)`、`idx_memory_archive_archived_by`、`idx_memory_archive_user_id`（`:1808-1810`）。

**memory_sleep_runs**（`:1802`）：

```sql
CREATE TABLE IF NOT EXISTS memory_sleep_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    examined INTEGER NOT NULL DEFAULT 0,
    archived_exact INTEGER NOT NULL DEFAULT 0,
    archived_expired INTEGER NOT NULL DEFAULT 0,
    archived_orphan INTEGER NOT NULL DEFAULT 0,
    archived_similarity INTEGER NOT NULL DEFAULT 0,
    archived_llm INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    error TEXT
)
```

枚举以 drizzle 为准（`:1226-1231`）：`status ∈ running|completed|failed|cancelled`，`trigger ∈ manual|idle|count|scheduled`。`input_tokens/output_tokens` 是后补列（`:1813-1827`，PRAGMA 检测后两条 ALTER，日志 `[MemoryService] Migrated: added token columns to memory_sleep_runs`）。`archived_orphan` 列存在但 v0.0.990 没有对应 layer 实现（预留）。索引：`idx_memory_sleep_runs_started_at(DESC)`（`:1811`）。

### 3.4 多 agent 编排域（6 张表）

CREATE 原文（`:2754-2769`）：

```sql
CREATE TABLE IF NOT EXISTS agent_missions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    root_message_id TEXT NOT NULL,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    shared_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES agent_missions(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    parent_run_id TEXT,
    spawned_by_handoff_id TEXT,
    execution_mode TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    input_summary TEXT NOT NULL,
    output_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
CREATE TABLE IF NOT EXISTS agent_handoffs (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES agent_missions(id) ON DELETE CASCADE,
    from_run_id TEXT,
    to_agent_id TEXT NOT NULL,
    to_agent_name TEXT NOT NULL,
    to_run_id TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    packet TEXT NOT NULL,
    result_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
CREATE TABLE IF NOT EXISTS mission_sprints (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES agent_missions(id) ON DELETE CASCADE,
    sprint_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
CREATE TABLE IF NOT EXISTS sprint_contracts (
    id TEXT PRIMARY KEY,
    sprint_id TEXT NOT NULL REFERENCES mission_sprints(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    criteria TEXT NOT NULL,
    negotiation_log TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
CREATE TABLE IF NOT EXISTS sprint_evaluations (
    id TEXT PRIMARY KEY,
    sprint_id TEXT NOT NULL REFERENCES mission_sprints(id) ON DELETE CASCADE,
    contract_id TEXT NOT NULL REFERENCES sprint_contracts(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    generator_run_id TEXT,
    evaluator_run_id TEXT,
    grades TEXT NOT NULL,
    overall_passed INTEGER NOT NULL DEFAULT 0,
    feedback_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

ALTER 增量：

- `agent_missions`：`harness_mode TEXT`、`spec_artifact_path TEXT`、`max_iterations INTEGER`、`current_phase TEXT`、`current_sprint_id TEXT`（`:3412-3432`）——harness 执行模式与 sprint 进度跟踪；
- `agent_runs`：`harness_role TEXT`、`sprint_id TEXT`、`attempt_number INTEGER`（`:3436-3443`）；
- `mission_sprints`：`agent_id TEXT`（`:3447`，CREATE 里已有，属冗余防御）。

逐列要点（drizzle 终态 `:888-1005`）：

- `agent_missions.root_message_id`：mission 挂到触发它的那条消息上；`UNIQUE INDEX idx_agent_missions_thread_root(thread_id, root_message_id)`（`:2978`）保证同一条消息不会开两个 mission。
- `agent_runs.task_id UNIQUE`：与子代理 TaskManager 的磁盘任务 ID 对齐；`parent_run_id` 构成 fork 树；`spawned_by_handoff_id` 记录本次 run 由哪次交接触发。
- `agent_handoffs.packet`（json）：交接包（目标 agent 的输入上下文）；`status` 默认 `created`。
- `sprint_contracts.criteria`（json）+ `version`：验收标准可反复磋商（`negotiation_log` json），每次改出版本 +1。
- `sprint_evaluations.grades`（json）+ `overall_passed INTEGER` + `attempt_number`：generator/evaluator 双 run 的「契约-评审」闭环，一次冲刺可多轮 attempt。

索引（`:2978-2986`）：mission 3 条、run 3 条（mission_id/parent_run_id/status）、handoff 3 条（mission_id/from_run_id/to_run_id）。

### 3.5 workspaces（工作区）

CREATE 原文（`:2799`）：

```sql
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    is_temporary INTEGER NOT NULL DEFAULT 0,
    show_in_list INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

ALTER 增量 11 列（`:3264-3301, 3450`）：

| 列 | 含义 |
|---|---|
| `remote_host_id` | → remote_hosts(id)，远程工作区（`:3450`） |
| `is_worktree` / `parent_workspace_id` / `worktree_branch` | git worktree 标记、父工作区、分支名（`:3264-3274`） |
| `auto_worktree` / `auto_worktree_base_branch` | 自动开 worktree 及基准分支（`:3279-3284`） |
| `pr_number` / `pr_url` / `pr_state` / `pr_base_branch` | 关联 GitHub PR（`:3288-3297`） |
| `is_session` | session 级临时工作区（`:3301`） |

索引：`idx_workspaces_is_temporary`、`idx_workspaces_show_in_list`（`:2999-3000`）。

### 3.6 plugins 家族 + prompt_apps

**plugins**（`:2811`）+ ALTER `install_url TEXT`（`:3361`）：

```sql
CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    description TEXT NOT NULL,
    author TEXT NOT NULL,
    icon TEXT,
    source TEXT NOT NULL,
    source_path TEXT NOT NULL,
    install_url TEXT,
    manifest TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    settings TEXT NOT NULL DEFAULT '{}',
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

`source` 为安装来源（如 npm/git/local），`manifest` 是完整插件清单 JSON，`settings` 是用户级配置 JSON。索引：`idx_plugins_enabled`、`idx_plugins_source`（`:3005-3006`）。

**plugin_permissions**（`:2814`）：`UNIQUE(plugin_id, permission)`，`status` 枚举 `granted|denied|pending`（drizzle `:1435-1439`）。注意有一次「检测不到 `created_at` 就 DROP 重建」的迁移（`:3364-3377`）——SQLite 无法 ADD COLUMN 带 NOT NULL 无默认时只能重建。

**plugin_state**（仅 drizzle 定义，`:1444-1455`）：`id PK, plugin_id → plugins CASCADE, key, value, created_at, updated_at`——插件 KV 存储。bundle 内无 CREATE TABLE 原文，复刻时按此定义补一条即可。

**prompt_apps**（`:2787`）+ ALTER 8 列（`:3173-3204`）：

```sql
CREATE TABLE IF NOT EXISTS prompt_apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    prompt_template TEXT NOT NULL,
    placeholders TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    shortcut TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
-- ALTER 增量：tools TEXT / reasoning_effort TEXT /
--   expects_image_result INTEGER NOT NULL DEFAULT 0 /
--   is_incognito INTEGER NOT NULL DEFAULT 0 /
--   window_width INTEGER / window_height INTEGER / font_size INTEGER
```

`prompt_template` + `placeholders`(JSON）是模板与占位符定义；ALTER 出来的 window_* / font_size 说明 prompt app 有独立小窗口。配套 `prompt_app_executions` 记每次执行（`input_values` JSON、`generated_prompt`、`attachment_count`，FK 双链 CASCADE/SET NULL，`:2790`）。索引：`idx_prompt_apps_enabled`、`idx_prompt_apps_sort_order`、executions 三条（`:2990-2994`）。

### 3.7 activity_* 家族（屏幕活动记录器，5 张表）

CREATE 原文（`:2838-2850`）：

```sql
CREATE TABLE IF NOT EXISTS activity_sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER,
    trigger_kind TEXT NOT NULL DEFAULT 'idle',
    app_names TEXT NOT NULL DEFAULT '[]',
    event_count INTEGER NOT NULL DEFAULT 0,
    snapshot_count INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    analysis_status TEXT NOT NULL DEFAULT 'pending',
    analysis_title TEXT,
    analysis_description TEXT,
    analysis_model TEXT,
    analysis_error TEXT,
    analyzed_at INTEGER,
    worth_memory INTEGER NOT NULL DEFAULT 0,
    worth_knowledge INTEGER NOT NULL DEFAULT 0,
    is_meeting INTEGER NOT NULL DEFAULT 0,
    storage_tier TEXT NOT NULL DEFAULT 'hot',
    entities TEXT NOT NULL DEFAULT '{}',
    topics TEXT NOT NULL DEFAULT '[]',
    project TEXT,
    highlights TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
)
CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    kind TEXT NOT NULL,
    app_name TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES activity_sessions(id) ON DELETE CASCADE
)
CREATE TABLE IF NOT EXISTS activity_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL DEFAULT 'heartbeat',
    app_name TEXT,
    window_title TEXT,
    hash_hex TEXT,
    histogram TEXT,
    diff_pct REAL,
    storage_tier TEXT NOT NULL DEFAULT 'hot',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES activity_sessions(id) ON DELETE CASCADE
)
CREATE TABLE IF NOT EXISTS activity_ocr_frames (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    char_count INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER NOT NULL DEFAULT 0,
    embedding BLOB,
    embedding_model TEXT,
    embedding_dim INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (snapshot_id) REFERENCES activity_snapshots(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES activity_sessions(id) ON DELETE CASCADE
)
CREATE TABLE IF NOT EXISTS activity_summaries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    date_key TEXT NOT NULL,
    summary TEXT,
    stats TEXT NOT NULL DEFAULT '{}',
    model TEXT,
    is_partial INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(kind, date_key)
)
```

逐列要点：

- `activity_sessions.analysis_status`：状态机 `pending|skipped|analyzed|not_worth|failed`；**注意 v0.0.990 有一次列改名迁移**——旧列 `crystal_status/crystal_title/.../crystallized_at` 被 `ALTER TABLE ... RENAME COLUMN ... TO analysis_*`（`:2913-2926`），并把历史值 `crystallized` 改写为 `analyzed`（`:2929`）。`entities`(JSON：prs/issues/commits/people/repos…)、`topics`、`project`、`highlights` 四列是 ALTER 增量（`:2939-2967`），由 LLM session 分析回填；`worth_memory/worth_knowledge` 是「值不值得写记忆/知识库」标志；`storage_tier` 默认 `hot`。
- `activity_events.kind`：`click|keypress|app_focus|lock|unlock|browser_visit|window_title|system`；`data` 为事件负载 JSON。
- `activity_snapshots`：`hash_hex`（160×90 缩略图 FNV hash）+ `histogram`（32 桶亮度直方图）+ `diff_pct` 三件套用于截图去重；`trigger` 五路：`heartbeat|visual_change|click|app_focus|typing_pause`。
- `activity_ocr_frames.embedding`：**BLOB（Float32Array 字节），不是 vec0**——OCR 语义搜索用纯 JS 余弦在 BLOB 上算，与记忆向量库完全分离；配套部分索引 `idx_activity_ocr_frames_embedding_null ON activity_ocr_frames(session_id) WHERE embedding IS NULL`（`:3031`）专供后台补 embedding 的 worker 扫未处理帧。
- `activity_summaries`：`UNIQUE(kind, date_key)`，kind 为 `daily|weekly`，`stats` JSON 里还塞 report 正文缓存。

activity 域索引共 12 条（`:3021-3033`），含 sessions 的 started_at/ended_at 双 DESC、events/snapshots 的 (session_id, timestamp) 复合索引。

### 3.8 providers + usage_records + 运行观测

**providers**（CREATE `:2772` + 13 列 ALTER `:3305-3358, 3606`）：

```sql
CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    api_key TEXT NOT NULL,
    models TEXT NOT NULL,
    base_url TEXT,
    api_version TEXT,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

ALTER 增量：`is_response_api`、`acp_command`、`acp_args`、`acp_mcp_server_ids`、`acp_auth_method_id`、`acp_api_provider_id`、`acp_model_mapping`、`use_max_completion_tokens`、`api_format`、`custom_headers`、`copilot_account_id`、`icon`、`available_models TEXT NOT NULL DEFAULT '[]'`。其中 `api_format` 的迁移带数据修正（`:3344-3347`）：

```sql
ALTER TABLE providers ADD COLUMN api_format TEXT;
UPDATE providers SET api_format = CASE WHEN is_response_api = 1 THEN 'openai-responses' ELSE 'openai-chat' END
WHERE type = 'custom' AND api_format IS NULL;
```

`type` 的 18 值枚举以 drizzle 为准（`:1009-1029`）：`openai / anthropic / google / aihubmix / openrouter / deepseek / copilot / azure / moonshot / custom / acp / claude-subscription / zai-coding-plan / kimi-coding-plan / opencode-go / cloudflare-ai-gateway / ollama / volcengine`。SQL 层曾有一次「探针式」重建去掉 type 的 CHECK 约束（`migrateProvidersTableRemoveTypeConstraint`，`:3453-3506`，见 §5.2）。`api_format` 枚举：`openai-chat | openai-responses | anthropic`（`:1050-1052`）。

索引：`idx_providers_type`、`idx_providers_enabled`（`:2987-2988`）。配套缓存表：`provider_models_cache`（`:2778`）、`model_capabilities_cache`（`:2775`）。

**usage_records**（`:2832`）：

```sql
CREATE TABLE IF NOT EXISTS usage_records (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    model TEXT,
    provider_id TEXT,
    date TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_input_tokens INTEGER DEFAULT 0,
    cache_write_input_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
)
```

token 六元组（input/output/cached_input/cache_write_input/reasoning/total）完整覆盖 OpenAI 缓存计费与推理模型的计量维度；`cache_write_input_tokens` 是 ALTER 增量（`:3380`）。`date` 是按日聚合键。索引 5 条：date、(model,date)、(provider_id,date)、message_id、thread_id（`:3011-3015`）。配套单行表 `usage_migration_status`（`CHECK(id=1)`，`:2835`）记录旧数据向用量体系的迁移进度（status/total_count/migrated_count/last_migrated_id…），迁移器见 `:73380, 102242-102327`。

**agent_op_traces / agent_op_trace_steps**（运行观测，CREATE 原文 `:2853-2856`）：

```sql
CREATE TABLE IF NOT EXISTS agent_op_traces (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    surface TEXT NOT NULL DEFAULT 'chat',
    model TEXT,
    provider_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    turn_end_reason TEXT NOT NULL DEFAULT 'unrecorded',
    turn_end_reason_normalized TEXT,
    turn_end_reason_source TEXT NOT NULL DEFAULT 'pending',
    step_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    context_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error_name TEXT,
    error_message TEXT,
    provider_response_id TEXT,
    metadata TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
CREATE TABLE IF NOT EXISTS agent_op_trace_steps (
    id TEXT PRIMARY KEY,
    op_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    step_number INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    raw_finish_reason TEXT,
    finish_reason TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    tool_names TEXT,
    text_preview TEXT,
    warnings TEXT,
    provider_response_id TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    created_at TEXT NOT NULL
)
```

设计要点：turn 级（traces）记结束原因三件套 `turn_end_reason`（原始）/ `_normalized`（归一化）/ `_source`（来源：pending 表示还没定）；step 级按 `step_type(call_llm|call_tool)` 逐条记，`tool_names`/`warnings` 为 JSON。索引：traces 的 message/thread(,started_at DESC)/status 三条，steps 的 (op_id, seq) 复合 + thread_id（`:3016-3020`）。bundle 里还有两条「下划线改连字符」的数据修正 UPDATE（`:2954-2960`）。

### 3.9 reference_links / reference_snippets（alma:// 引用图谱）

CREATE 原文（`:2859, 2895`）：

```sql
CREATE TABLE IF NOT EXISTS reference_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_uri TEXT NOT NULL,
    to_uri TEXT NOT NULL,
    to_kind TEXT NOT NULL,
    label TEXT,
    thread_id TEXT,
    message_id TEXT,
    slot_id TEXT,
    role TEXT,
    source TEXT NOT NULL DEFAULT 'message',
    created_at TEXT NOT NULL
)
CREATE TABLE IF NOT EXISTS reference_snippets (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    message_id TEXT,
    slot_id TEXT,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL
)
```

`from_uri/to_uri` 是 `alma://` URI（19 种 kind：thread/message/snippet/file/project/host/skill/agent/mission/plan/prompt/mcp/model/memory/artifact/tool/task/provider/cron）。`source` 列为 ALTER 增量（`:2883`），默认 `message`（正文扫描出来源）。唯一约束经历过修正：先 `DROP INDEX IF EXISTS idx_reference_links_unique` 再建 `(from_uri, to_uri, source)` 三联唯一索引（`:2887-2892`）。索引另有 to/from/message/thread 四条（`:2863-2879`）。snippets 靠 `text_hash` 去重，索引 `(thread_id, created_at)`（`:2899`）。

---

## 4. 其余表（SQL 原文 + 一句话用途）

以下 SQL 均可在 `tables-all.sql` 核对原文；行号为 bundle 位置。

**app_settings**（`:2751`）——单行（`id='default'`）整棵 AppSettings JSON：

```sql
CREATE TABLE IF NOT EXISTS app_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    settings_data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**mcp_servers**（`:2796`）——MCP 服务器配置（`config` 为完整 JSON，`status` 默认 disconnected）：

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    registry_id TEXT,
    name TEXT NOT NULL,
    description TEXT,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'disconnected',
    last_error TEXT,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**mcp_oauth_tokens**（`:2817`）——MCP OAuth2.1 全套字段（含 PKCE `code_verifier`、动态注册 `client_id_issued_at` 等）；经历过「去外键」重建（§5.2）：

```sql
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    authorization_server_url TEXT,
    resource_url TEXT,
    client_id TEXT,
    client_secret TEXT,
    client_id_issued_at INTEGER,
    client_secret_expires_at INTEGER,
    access_token TEXT,
    refresh_token TEXT,
    token_type TEXT,
    expires_at INTEGER,
    scope TEXT,
    code_verifier TEXT,
    last_refresh_at TEXT,
    last_error_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**remote_hosts**（`:2802`）——SSH 远程主机（`ssh_target` 形如 user@host，`source` 区分 manual/发现）：

```sql
CREATE TABLE IF NOT EXISTS remote_hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ssh_target TEXT NOT NULL,
    port INTEGER,
    identity_file TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**preview_servers**（`:3259`）——工作区预览服务（port/command/pid 三要素 + status 状态机）：

```sql
CREATE TABLE IF NOT EXISTS preview_servers (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    port INTEGER NOT NULL,
    project_type TEXT NOT NULL,
    command TEXT NOT NULL,
    pid INTEGER,
    status TEXT NOT NULL DEFAULT 'stopped',
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**prompts**（`:2805`）——快捷提示词片段（`name` 唯一）：

```sql
CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**skills**（`:2808`）——技能启用/排序状态（`path` 指向磁盘上的 SKILL.md，内容不落库）：

```sql
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
)
```

**custom_themes**（`:2820`）——自定义主题（`base_30`/`base_16` 两套色板 JSON，CHECK 限定 dark/light）：

```sql
CREATE TABLE IF NOT EXISTS custom_themes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('dark', 'light')),
    base_30 TEXT NOT NULL,
    base_16 TEXT NOT NULL,
    based_on TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**thread_labels**（`:2823`）——线程标签定义（与 thread 的关联在 `chat_threads.metadata`）：

```sql
CREATE TABLE IF NOT EXISTS thread_labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**channel_mappings**（`:2826`）——外部平台（telegram/discord/feishu/lark/weixin）↔ 内部 thread 的映射：

```sql
CREATE TABLE IF NOT EXISTS channel_mappings (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    external_chat_id TEXT NOT NULL,
    external_user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**gallery_images**（`:2793`）+ ALTER 5 列（`:3047-3067`）——生成图片画廊索引（按 message CASCADE；`thread_title/width/height/aspect_ratio/file_path` 是后补的展示与磁盘列）：

```sql
CREATE TABLE IF NOT EXISTS gallery_images (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    thread_title TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    filename TEXT,
    width INTEGER,
    height INTEGER,
    aspect_ratio REAL,
    file_path TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
)
```

**gallery_cache_meta**（`:4131`）——画廊缓存 schema 版本 KV：

```sql
CREATE TABLE IF NOT EXISTS gallery_cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
```

**thread_diff_stats_cache**（`:2781`）——线程 diff 统计缓存（`thread_updated_at` 作失效键）：

```sql
CREATE TABLE IF NOT EXISTS thread_diff_stats_cache (
    id TEXT PRIMARY KEY,
    thread_updated_at TEXT NOT NULL,
    additions INTEGER NOT NULL DEFAULT 0,
    deletions INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**tool_group_summaries**（`:2784`）——连续工具调用组的 LLM 摘要缓存（`segment_key` 主键定位消息内片段）：

```sql
CREATE TABLE IF NOT EXISTS tool_group_summaries (
    segment_key TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    tool_signature TEXT,
    summaries TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**model_capabilities_cache / provider_models_cache**（`:2775, 2778`）——模型能力 / provider 模型列表的拉取缓存：

```sql
CREATE TABLE IF NOT EXISTS model_capabilities_cache (
    id TEXT PRIMARY KEY,
    capabilities TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
CREATE TABLE IF NOT EXISTS provider_models_cache (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    models TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

**usage_migration_status**（`:2835`）——单行（`CHECK (id = 1)`）用量迁移进度：

```sql
CREATE TABLE IF NOT EXISTS usage_migration_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'pending',
    total_count INTEGER DEFAULT 0,
    migrated_count INTEGER DEFAULT 0,
    last_migrated_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT
)
```

**computer_use_app_approvals / computer_use_action_log**（`:2903-2906`）——桌面自动化的按应用授权记忆与动作审计：

```sql
CREATE TABLE IF NOT EXISTS computer_use_app_approvals (
    bundle_id TEXT PRIMARY KEY,
    app_name TEXT,
    approved_at TEXT,
    revoked_at TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT
)
CREATE TABLE IF NOT EXISTS computer_use_action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    logged_at TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    bundle_id TEXT,
    pid INTEGER,
    args_json TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    screenshot_sha TEXT,
    error_code TEXT
)
```

**migrations**（`:2829`）——迁移记账（见 §5.2）：

```sql
CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    executed_at TEXT NOT NULL
)
```

**plugin_state**（仅 drizzle，`:1444`）——插件 KV 状态：`id PK, plugin_id → plugins(id) CASCADE, key, value, created_at, updated_at`。

---

## 5. 迁移机制（复刻重点）

v0.0.990 的迁移是四种模式的混合体，全部在启动时同步跑在 `createTables()` 尾部。

### 5.1 模式一：裸 ALTER + try/catch 吞错（主力，约 60 条）

绝大多数加列就是一行 `ALTER TABLE ... ADD COLUMN` 套在 `try {} catch {}` 里——列已存在时 SQLite 抛 `duplicate column name`，直接吞掉当无事发生。原文实例（`:3147-3159`）：

```js
try { this.sqlite.exec("ALTER TABLE chat_messages ADD COLUMN parent_id TEXT"); } catch {}
try { this.sqlite.exec("ALTER TABLE chat_messages ADD COLUMN slot_id TEXT"); } catch {}
try {
    this.sqlite.exec("ALTER TABLE chat_messages ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
} catch {}
try {
    this.sqlite.exec("ALTER TABLE chat_messages ADD COLUMN parent_tool_call_id TEXT");
} catch {}
```

伴随的数据修正 UPDATE 同样吞错（如 `:3076-3086` 给 `chat_messages.metadata` 补 `'{}'`、`updated_at` 回填 `created_at`；`:3346` 的 api_format 回填）。

**局限**：`ADD COLUMN` 不能加 `NOT NULL` 无默认列、不能带复杂约束；所以新增 NOT NULL 列一律带 `DEFAULT`（如 `available_models TEXT NOT NULL DEFAULT '[]'`），或者走模式三重建。

### 5.2 模式二：migrations 表记账的「正式迁移」（数据迁移/一次性修复用）

记账读写（`:3507-3527`）：

```js
hasMigrationRun(e) {
    return !!this.sqlite.prepare("SELECT 1 FROM migrations WHERE name = ?").get(e);
}
markMigrationComplete(t) {
    this.sqlite.prepare(
        "INSERT OR REPLACE INTO migrations (name, executed_at) VALUES (?, ?)"
    ).run(t, new Date().toISOString());
}
```

bundle 里可考的迁移名：`duplicate_predefined_providers_v1`（合并 openai/anthropic/gemini/openrouter 重复 provider，`:3529-3600`）、`mcp_oauth_tokens_remove_fk_v1`（`:3774`）、`capabilities_to_capability_overrides_v1`（`:3827`）。特征：只跑一次、带 `BEGIN TRANSACTION`/`COMMIT`/`ROLLBACK`、失败打日志不炸启动。

### 5.3 模式三：PRAGMA table_info 检测 → 条件 ALTER 或 DROP 重建

需要「先看再动手」时用 `PRAGMA table_info(...)`。两个原文实例：

```js
// :1813-1827  memory_sleep_runs 补 token 列
const e = this.sqlite.prepare("PRAGMA table_info(memory_sleep_runs)").all();
e.length > 0 && !e.some((e) => "input_tokens" === e.name) &&
    (this.sqlite.exec("ALTER TABLE memory_sleep_runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0"),
     this.sqlite.exec("ALTER TABLE memory_sleep_runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0"),
     console.log("[MemoryService] Migrated: added token columns to memory_sleep_runs"));

// :1831-1842  memories 补 user_id
this.sqlite.prepare("PRAGMA table_info(memories)").all()
    .some((e) => "user_id" === e.name) ||
    (this.sqlite.exec("ALTER TABLE memories ADD COLUMN user_id TEXT"),
     this.sqlite.exec("CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id)"));
```

改不了约束时只能重建表（CREATE new → INSERT SELECT → DROP → RENAME）。两例原文：

- **providers 去 type CHECK 约束**（`:3453-3506`）：先插入一条 `type='__test_type__'` 的探针记录，若报 `CHECK constraint failed` 则重建——用探针代替「解析 sqlite_master 的 sql」，很土但有效；
- **mcp_oauth_tokens 去外键**（`:3796-3810`，有 migrations 记账）：

```sql
CREATE TABLE mcp_oauth_tokens_new ( ... 无 REFERENCES 版本 ... );
INSERT INTO mcp_oauth_tokens_new SELECT * FROM mcp_oauth_tokens;
DROP TABLE mcp_oauth_tokens;
ALTER TABLE mcp_oauth_tokens_new RENAME TO mcp_oauth_tokens;
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_server_id ON mcp_oauth_tokens(server_id);
```

另有 `plugin_permissions` 的「PRAGMA 检测不到 `created_at` 列就整表 DROP 重建」（`:3364-3377`，权限数据可丢所以直接 DROP 不搬数据）。以及一次「FTS 版本号 < 6 就 DROP 重建」（`:3890-3895`）。

### 5.4 模式四：RENAME COLUMN / 修复残留

`activity_sessions` 的 `crystal_*` → `analysis_*` 批量改名（`:2913-2926`）+ 历史值改写（`:2929`）+ 旧索引清理（`:2934`）。还有一个彩蛋级修复：历史上某次重建 `chat_messages` 留下了外键指向 `chat_messages_old` 的孤儿表，启动时扫 `sqlite_master` 找 `sql LIKE '%chat_messages_old%'` 的表，逐个做「SQL 文本替换表名 → 建 `_fk_fix` 新表 → 搬数据 → DROP → RENAME」（`:3097-3144`，全程 `PRAGMA foreign_keys=OFF` + 事务）。

### 5.5 可复刻的迁移器骨架

把 Alma 的模式提炼成一个最小迁移器（TypeScript + better-sqlite3），行为与 Alma 等价但更整洁：

```ts
import type Database from "better-sqlite3";

/** 幂等加列：Alma 用 try/catch 吞 duplicate column，这里用 PRAGMA 检测更干净 */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** 一次性迁移：migrations 表记账（等价 Alma 的 hasMigrationRun/markMigrationComplete） */
function runOnce(db: Database.Database, name: string, fn: () => void) {
  const hit = db.prepare("SELECT 1 FROM migrations WHERE name = ?").get(name);
  if (hit) return;
  db.exec("BEGIN TRANSACTION");
  try {
    fn();
    db.prepare("INSERT OR REPLACE INTO migrations (name, executed_at) VALUES (?, ?)")
      .run(name, new Date().toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e; // Alma 选择吞掉只打日志；复刻时建议上抛，避免半迁移状态被记账
  }
}

/** 重建表改约束（等价 providers_new / mcp_oauth_tokens_new 模式） */
function rebuildTable(
  db: Database.Database,
  table: string,
  newDDL: string,
  copyColumns: string[],          // 新旧表交集列
  indexes: string[] = [],         // 重建后要补的索引 SQL
) {
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(newDDL.replace("{{name}}", `${table}_new`));
    const cols = copyColumns.join(", ");
    db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    for (const idx of indexes) db.exec(idx);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
```

启动顺序照抄 Alma：`PRAGMA（WAL/外键/超时）→ CREATE TABLE IF NOT EXISTS 全量基线 → CREATE INDEX IF NOT EXISTS 全量 → ensureColumn 补增量列 → runOnce 数据迁移 → 版本号 KV（fts_metadata.version 这类）检测式重建`（对应 `:2691-2702, 2970-3034, 3403-3409` 的执行序）。

---

## 6. FTS5 与 vec0

### 6.1 messages_fts：历史消息关键词搜索（jieba 预分词）

建表与版本控制（`:3874-3924`）：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    message_id UNINDEXED,
    thread_id UNINDEXED,
    content
)
CREATE TABLE IF NOT EXISTS fts_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
```

要点：

- **不用 FTS5 tokenizer 处理中文**。入库前过 `ur()`（`:2557-2574`）：正则 `[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]` 命中 CJK/日文/韩文区段时，把命中的子串用 **jieba-wasm**（`import { cut as ze } from "jieba-wasm"`，`:153-155`）切词后以空格连接，非 CJK 段原样拼接。FTS5 侧用默认 unicode61 tokenizer 吃空格分词后的文本即可命中中文。
- `fts_metadata.version` 当前为 **6**；低于 6 就 `DROP TABLE IF EXISTS messages_fts` 全量重建（`:3890-3921`）。日志原话：`"Dropping old FTS table for recreation with jieba segmentation"`——说明旧版本用的是简单空格分词，jieba 是某次升级引入的。
- **同步不靠触发器，靠应用代码**：消息写入/更新路径调 `updateFtsForMessage(messageId, threadId, messageJson)`（先 `DELETE FROM messages_fts WHERE message_id = ?` 再 INSERT，`:3987-4009`；调用点 `:5311/5358/5467/5487`，`skipFtsIndex` 可跳过）；删除走 `deleteFtsForMessage` / `deleteFtsForThread`（`:4056-4075`）。
- 内容提取：从 UIMessage JSON 的 `parts`（或 `content`）数组里只取 `type === "text"` 的 text 段拼接（`extractTextFromMessageObject`，`:3969-3986`）——工具调用、推理段不进索引。
- 检索 SQL（`:6328`）：

```sql
SELECT thread_id, message_id
FROM messages_fts
WHERE messages_fts MATCH ?
ORDER BY rank
LIMIT 1000
```

**注意：这张表只服务 `alma thread search` / grep 这类历史会话搜索，与记忆检索零融合**（bundle 全文 grep 不到 `rrf|reciprocal|bm25|hybrid`）。

### 6.2 memory_embeddings：vec0 向量检索

sqlite-vec 加载（`:1684-1766`）：按 `process.platform + arch` 拼 `sqlite-vec-{platform}-{arch}` 包名找 `vec0.{dylib|dll|so}`，打包态优先 `process.resourcesPath` 下的 `app.asar.unpacked/node_modules`，失败回退 `require("sqlite-vec").getLoadablePath()`。

检索 SQL（`searchMemories`，`:2186-2190`）——**就是纯 KNN，无混合**：

```sql
SELECT
    memory_id,
    1 - vec_distance_cosine(embedding, ?) as score
FROM memory_embeddings
WHERE score >= ?
ORDER BY score DESC
LIMIT ?
```

命中后再回 `memories` 表取正文，并做 userId/threadId/tags 后置过滤，同时把命中条的 `accessCount+1`、`lastAccessedAt=now` 写回 metadata（`:2222-2238`，供 sleep 的幸存者优先级打分用）。

**维度迁移**（换 embedding 模型时）：

1. `ensureVectorTableDimensions(n)`（`:1848-1860`）：vec0 表**为空**时直接 DROP 重建为新维度；非空不动。
2. `rebuildEmbeddings(provider)`（`:1884-1984`）：非空时的完整流程——取第一条记忆试算新维度 `r` → `DROP TABLE IF EXISTS memory_embeddings` + `CREATE VIRTUAL TABLE ... FLOAT[${r}]` → 每 10 条一批并发生成 embedding 重灌（`AbortController` 支持取消，`/api/memories/rebuild|rebuild-progress|cancel-rebuild` 暴露给 UI）→ 最后 `memory_metadata.embedding_model` 记账。`hasEmbeddingModelChanged`（`:1880`）检测漂移触发 UI 提示。

**已知坑（复刻别学）**：`memory_embeddings` 的 INSERT/UPDATE 是**字符串拼接 SQL**（`:1919-1922, 1949-1952, 2099, 2297`），形如：

```js
this.sqlite.exec(`
    INSERT INTO memory_embeddings (memory_id, embedding)
    VALUES ('${n[0].id}', '${s}')   // s = JSON.stringify(embedding 数组)
`);
```

复刻务必参数化（`?` 绑定）；vec0 接受 JSON 数组字符串或 Float32Array BLOB。

**embedding 提供方优先级**（`getEmbeddingProvider`，调用点 `:86678, 87380`）：`settings.memory.embeddingModel`（`providerId:modelId`，`__local__` = 本地 transformers.js）→ 第一个 enabled 的 openai provider（默认 `text-embedding-3-small`）→ aihubmix → openrouter → google（`text-embedding-004`）→ custom OpenAI 兼容端点。本地实现是 `@huggingface/transformers` 动态 import，4 个候选模型全是 384 维 Xenova 版。也就是说 **1536 维只是「新建库 + 云端默认模型」的组合结果，不是硬编码**。

---

## 7. 与旧版 03 篇 §4 的差异速查

1. **embedding 默认 384→1536**：旧文档记 `FLOAT[384]` 是本地 transformers.js 时代的形态；v0.0.990 新建库默认 `FLOAT[1536]`（`:1793`），维度随模型动态重建。
2. **「混合检索」不存在**：记忆检索 = 纯 vec0 余弦 KNN + 元数据后置过滤；FTS5 只管历史消息搜索，两条链路不融合。中文检索靠 jieba 预分词（消息侧）和 LLM 查询改写（记忆侧）分别解决。
3. **memories 多了 `user_id`**：渠道用户命名空间隔离（`:1836`）。
4. **memory_sleep_runs 多了 token 两列**（`:1820-1823`），且 `status/trigger` 枚举坐实为 `running|completed|failed|cancelled` / `manual|idle|count|scheduled`。
5. **chat_messages 多了 `parent_tool_call_id`**（`:3159`），用于子 agent 消息树挂载与主线过滤。
6. **chat_threads 的 ALTER 列全部坐实**：`parent_thread_id`、`tools_compact_view`、`skill_ids` 等旧文档标注的增量列在 v0.0.990 仍是 ALTER 形态（`:3207-3254`），CREATE 基线没合入。
7. **新表成批**：`agent_op_traces/steps`、`reference_links/snippets`、`activity_*` 五张、`computer_use_*` 两张、`remote_hosts`、`plugin_state`——旧版完全没有。
8. **providers 终态 24 列**：ACP 七列 + `api_format`/`custom_headers`/`copilot_account_id`/`icon`/`available_models` 均为 ALTER 增量；`type` 枚举扩到 18 值。
9. **迁移史可考**：`crystal_*→analysis_*` 改名（`:2913`）、providers 去 CHECK 探针重建（`:3453`）、mcp_oauth_tokens 去 FK 重建（`:3772`）、FTS version 6 jieba 重建（`:3890`）——都是研究 Alma 演进的一手材料。
10. **不变的部分**：单库 `chat_threads.db` + WAL + 那六条 pragma、better-sqlite3 + drizzle、`memory_archive` 软删除、`app_settings` 单行 JSON、`migrations` 记账表——旧文档这些论断在 v0.0.990 全部仍成立。

---

## 8. 复刻要点清单

- **最小可跑集合**：`chat_threads` + `chat_messages` + `app_settings` + `providers` + `migrations` + `messages_fts`/`fts_metadata` + `memories`/`memory_embeddings`/`memory_metadata` 即可支撑「多会话 + 版本树 + 全文搜索 + 向量记忆」的 MVP。
- **版本树**：`parent_id/slot_id/depth` + `chat_threads.metadata.activePath`，选版本逻辑照 §3.2 抄；`idx_messages_version_info` 复合索引必须有。
- **记忆闭环**：三表 + 检索 SQL（§6.2 原文）+ `## Relevant Memories` 注入；写入侧加 LLM 判重（候选 5 条 / threshold 0.3）。
- **sleep 整理**：`memory_archive` 软删除 + `memory_sleep_runs` 记账，四层 reason（`exact_dup|expired|similarity_merge|llm_merge`），参数 0.95/0.75/30 天/批 20/簇上限 50。
- **迁移器**：照 §5.5 骨架；核心纪律是「CREATE 永远 IF NOT EXISTS、加列永远幂等、改约束才重建、数据迁移必记账」。
- **参数化**：`memory_embeddings` 的写入 Alma 用了字符串拼接，复刻必须改 `?` 绑定。
- **可以先不建**：`archived_orphan` 列（无实现）、`plugin_state`（无 CREATE 原文，用到再建）、`rtk-tracking.db`（sidecar 私库，不属于主库 schema）。
