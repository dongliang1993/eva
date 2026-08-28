import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default("New Chat"),
    model: text("model"),
    origin: text("origin").notNull().default("chat"),
    metadata: text("metadata").notNull().default("{}"),
    workspaceId: text("workspace_id"),
    /** 会话当前激活分支的叶子消息。为空(老会话)→ 读路径退化用时间上最后一条。 */
    activeLeafId: text("active_leaf_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index("idx_sessions_updated_at").on(table.updatedAt),
    index("idx_sessions_origin").on(table.origin),
    index("idx_sessions_workspace_id").on(table.workspaceId)
  ]
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [uniqueIndex("idx_workspaces_path").on(table.path)]
);

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull().default("custom"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  apiKey: text("api_key").notNull().default(""),
  baseUrl: text("base_url").notNull().default(""),
  models: text("models").notNull().default("[]"),
  availableModels: text("available_models").notNull().default("[]"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`)
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default("")
});

export const memoryCategories = [
  "user",
  "preference",
  "project",
  "decision",
  "knowledge"
] as const;

export type MemoryCategory = (typeof memoryCategories)[number];

export const memoryOrigins = ["manual", "tool_saved"] as const;

export type MemoryOrigin = (typeof memoryOrigins)[number];

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    category: text("category", { enum: memoryCategories })
      .notNull()
      .default("knowledge"),
    origin: text("origin", { enum: memoryOrigins })
      .notNull()
      .default("manual"),
    content: text("content").notNull(),
    metadata: text("metadata").notNull().default("{}"),
    sourceSessionId: text("source_session_id"),
    sourceMessageId: text("source_message_id"),
    userId: text("user_id").notNull().default("default"),
    embeddingStatus: text("embedding_status").notNull().default("pending"),
    embeddingModel: text("embedding_model"),
    embeddedAt: text("embedded_at"),
    lastRecalledAt: text("last_recalled_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index("idx_memories_user_id").on(table.userId),
    index("idx_memories_category").on(table.category),
    index("idx_memories_embedding_status").on(table.embeddingStatus),
    index("idx_memories_created_at").on(table.createdAt)
  ]
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    /** 完整 UIMessage JSON —— 这条消息的唯一事实源。 */
    message: text("message").notNull(),
    /** FTS5 索引源,由 uiMessageSearchText(message) 派生。 */
    searchText: text("search_text").notNull().default(""),
    // 版本树三件套(docs 14 §7.2)。T1 只按线性链写入,分支 UI 留到后续切片。
    parentId: text("parent_id"),
    slotId: text("slot_id"),
    depth: integer("depth").notNull().default(0),
    /** S7:子代理进程消息的挂点;主链构建时按 IS NULL 过滤(见 message-tree.ts)。 */
    parentToolCallId: text("parent_tool_call_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index("idx_messages_session_id").on(table.sessionId),
    index("idx_messages_created_at").on(table.createdAt),
    index("idx_messages_run_id").on(table.runId),
    index("idx_messages_parent_tool_call").on(table.parentToolCallId)
  ]
);

// 后台子代理任务事实表(S7)。transcript 在 messages 表,这里只存任务状态与结局。
export const backgroundTasks = sqliteTable(
  "background_tasks",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    parentToolCallId: text("parent_tool_call_id").notNull(),
    subagentType: text("subagent_type").notNull(),
    /** subagent 工具给的 3-5 词任务名 —— 卡片标题与通知文本都用它。 */
    description: text("description").notNull().default(""),
    depth: integer("depth").notNull().default(0),
    status: text("status", { enum: ["running", "done", "failed"] })
      .notNull()
      .default("running"),
    result: text("result"),
    error: text("error"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    endedAt: text("ended_at")
  },
  (table) => [
    index("idx_background_tasks_session").on(table.sessionId)
  ]
);

export const runStatuses = ["running", "completed", "aborted", "error"] as const;

export type RunStatus = (typeof runStatuses)[number];

/** 失败归因(设计文档 §8)。aborted 由 status 表达,不进这个枚举。 */
export const runFailureLayers = [
  "routing",
  "model",
  "tool",
  "context",
  "orchestration",
  "unknown"
] as const;

export type RunFailureLayer = (typeof runFailureLayers)[number];

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** 后台子代理来源 Run;NULL 即主 Run(S27/T48)。删除父 Run 级联子 Run。 */
    parentRunId: text("parent_run_id").references(
      (): AnySQLiteColumn => runs.id,
      { onDelete: "cascade" }
    ),
    /** 后台子代理对应的 background_tasks.id;类型与发起 Tool Call 由该行反查,不冗余。 */
    backgroundTaskId: text("background_task_id"),
    status: text("status", { enum: runStatuses }).notNull().default("running"),
    /** 路由前请求的模型(请求 modelId / 会话记录),解析失败时只有它有值。 */
    requestedModel: text("requested_model"),
    /** 解析后的实际模型,"providerId:modelId";patchRouting 在解析成功后补。 */
    model: text("model"),
    failureLayer: text("failure_layer", { enum: runFailureLayers }),
    /** 这条 Run 当时的 observability.captureContent —— 设置是可变的,事实要定格。 */
    captureLevel: text("capture_level"),
    userMessageId: text("user_message_id"),
    assistantMessageId: text("assistant_message_id"),
    finishReason: text("finish_reason"),
    /** StreamTokenUsage JSON。 */
    usage: text("usage"),
    error: text("error"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    endedAt: text("ended_at")
  },
  (table) => [
    index("idx_runs_session_id").on(table.sessionId),
    index("idx_runs_status").on(table.status),
    index("idx_runs_parent_run_id").on(table.parentRunId),
    index("idx_runs_background_task_id").on(table.backgroundTaskId)
  ]
);

export const runEventSeverities = ["info", "warn", "error"] as const;

export type RunEventSeverity = (typeof runEventSeverities)[number];

/**
 * append-only 执行事实 ledger(S27/T47)。start/completed 配对,不 UPDATE 旧行;
 * 崩溃收口靠启动清扫追加 abandoned 事件。时间一律 epoch ms —— 与 runs/messages
 * 的 ISO text 只做 run_id 关联,不做跨表时间运算。
 *
 * seq 由 Run 级 recorder 独占单调分配(同一 Run 主 Agent 与前台子代理共用),
 * UNIQUE(run_id, seq) 靠这个纪律成立。
 */
export const runEvents = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // 冗余列:会话轨迹每页都要先按 session 限定再排序,JOIN runs 再 ORDER BY 用不上索引。
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** "main" | taskId(前台子代理)。 */
    agent: text("agent").notNull(),
    kind: text("kind").notNull(),
    turnIndex: integer("turn_index"),
    stepIndex: integer("step_index"),
    attempt: integer("attempt"),
    toolCallId: text("tool_call_id"),
    parentToolCallId: text("parent_tool_call_id"),
    severity: text("severity", { enum: runEventSeverities })
      .notNull()
      .default("info"),
    /** 已脱敏、已限长的 canonical JSON(键排序、无空白 —— hash 稳定性靠它)。 */
    payload: text("payload").notNull(),
    occurredAtMs: integer("occurred_at_ms").notNull(),
    durationMs: integer("duration_ms")
  },
  (table) => [
    uniqueIndex("uq_run_events_run_seq").on(table.runId, table.seq),
    index("idx_run_events_run_tool_call").on(table.runId, table.toolCallId),
    index("idx_run_events_run_time").on(table.runId, table.occurredAtMs),
    index("idx_run_events_session_time").on(
      table.sessionId,
      table.occurredAtMs,
      table.runId,
      table.seq
    )
  ]
);

/**
 * token 用量独立表(T21)。runs.usage JSON 里 SQL 进不去,按天/按模型聚合
 * 与 cache 命中成本核算都要这张表。写入是 settle 时与 runs.usage 双写;
 * 历史 JSON 不回填(本地单机库,历史用量没有决策价值)。
 */
export const usageRecords = sqliteTable(
  "usage_records",
  {
    id: text("id").primaryKey(),
    // T48:去掉 runs 外键 —— retention 会整 Run 删除(§7.1),usage 聚合独立存活。
    // 关联仍在(run_id 值不变),只是生命周期不再绑死。
    runId: text("run_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** "providerId:modelId" —— 与 runs.model 同源,冗余进本表免得聚合时 JOIN。 */
    model: text("model"),
    /** YYYY-MM-DD(UTC) —— 按天聚合的 GROUP BY 键,settle 时算好写入。 */
    date: text("date").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    /** T40:写入 prompt cache 的 input tokens(0025 加列;T21 时 SDK 不暴露而砍,v7 已标准化)。 */
    cacheWriteTokens: integer("cache_write_input_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index("idx_usage_records_session").on(table.sessionId),
    index("idx_usage_records_date").on(table.date),
    index("idx_usage_records_model").on(table.model)
  ]
);

export const sessionCompactions = sqliteTable(
  "session_compactions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    coveredUntilMessageId: text("covered_until_message_id").notNull(),
    coveredMessageCount: integer("covered_message_count").notNull(),
    preservedTailMessageCount: integer("preserved_tail_message_count").notNull(),
    estimatedTokensBefore: integer("estimated_tokens_before"),
    estimatedTokensAfter: integer("estimated_tokens_after"),
    trigger: text("trigger").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    uniqueIndex("idx_session_compactions_session_id").on(table.sessionId)
  ]
);

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(), // tool callId
    sessionId: text("session_id").notNull(),
    runId: text("run_id"),
    tool: text("tool").notNull(),
    /** T45b:普通工具审批 vs plan review 平行通道;老行默认 tool,读法不变。 */
    kind: text("kind", { enum: ["tool", "plan_review"] })
      .notNull()
      .default("tool"),
    args: text("args").notNull(), // JSON
    status: text("status", {
      enum: ["pending", "granted", "denied", "revise", "reject_and_exit", "dismissed"]
    })
      .notNull()
      .default("pending"),
    /** T45b:kind='plan_review' 时存 PlanReviewDecision JSON(定格/刷新重建用)。 */
    decision: text("decision"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    decidedAt: text("decided_at"),
    /** T28:这次决策是谁做的 —— policy:<key> / stale-restart / 未来 readonly-safe;NULL = 用户手批。 */
    reason: text("reason")
  },
  (table) => [
    index("idx_approval_requests_session").on(table.sessionId),
    index("idx_approval_requests_status").on(table.status),
    index("idx_approval_requests_run").on(table.runId)
  ]
);

export const mcpTransports = ["stdio", "http"] as const;

export const mcpOrigins = ["manual", "file"] as const;

export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    /** 工具名前缀 —— mcp__<name>__<tool>。限 [a-z0-9_-]+，唯一。 */
    name: text("name").notNull(),
    /** file 来自 ~/.eva/mcp.json，UI 只能启停；manual 由 UI 创建，文件同步不碰。 */
    origin: text("origin", { enum: mcpOrigins }).notNull().default("manual"),
    transport: text("transport", { enum: mcpTransports }).notNull(),
    command: text("command"),
    /** JSON string[]。 */
    args: text("args").notNull().default("[]"),
    /** JSON Record<string,string>。含密钥，不回给前端。 */
    env: text("env").notNull().default("{}"),
    url: text("url"),
    /** JSON Record<string,string>。含密钥，不回给前端。 */
    headers: text("headers").notNull().default("{}"),
    /** JSON string[] —— 免审批的 MCP 侧工具原名。 */
    autoApproveTools: text("auto_approve_tools").notNull().default("[]"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    uniqueIndex("idx_mcp_servers_name").on(table.name),
    index("idx_mcp_servers_origin").on(table.origin)
  ]
);

export const sessionSkillSelectionOrigins = ["auto", "forced"] as const;

export type SessionSkillSelectionOrigin =
  (typeof sessionSkillSelectionOrigins)[number];

/** T44:skill auto-selection 的 thread 累积集(LLM 选中不可重放,落选表)。 */
export const sessionSkillSelections = sqliteTable(
  "session_skill_selections",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    skillName: text("skill_name").notNull(),
    origin: text("origin", { enum: sessionSkillSelectionOrigins })
      .notNull()
      .default("auto"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.skillName] }),
    index("idx_session_skill_selections_session").on(table.sessionId)
  ]
);

export const planStatuses = ["active", "approved", "rejected"] as const;

export type PlanStatus = (typeof planStatuses)[number];

/** T45a:Plan Gate 的 session 级规划态。plan 文件在 workspace 的 .eva/plan-gate/ 下。 */
export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    status: text("status", { enum: planStatuses }).notNull().default("active"),
    revisionCount: integer("revision_count").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [index("idx_plans_session_status").on(table.sessionId, table.status)]
);
