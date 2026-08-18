import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default("New Chat"),
    sessionKey: text("session_key").notNull(),
    model: text("model"),
    reasoningEffort: text("reasoning_effort").notNull().default("medium"),
    origin: text("origin").notNull().default("chat"),
    toolPolicy: text("tool_policy").notNull().default("auto"),
    skillPolicy: text("skill_policy").notNull().default("auto"),
    memoryPolicy: text("memory_policy").notNull().default("auto"),
    metadata: text("metadata").notNull().default("{}"),
    workspaceId: text("workspace_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index("idx_sessions_session_key").on(table.sessionKey),
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

export const providerModelsCache = sqliteTable(
  "provider_models_cache",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    models: text("models").notNull().default("[]"),
    fetchedAt: text("fetched_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [index("idx_pmc_provider_id").on(table.providerId)]
);

export const modelCapabilitiesCache = sqliteTable(
  "model_capabilities_cache",
  {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull(),
    capabilities: text("capabilities").notNull().default("{}"),
    fetchedAt: text("fetched_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [index("idx_mcc_model_id").on(table.modelId)]
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
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index("idx_messages_session_id").on(table.sessionId),
    index("idx_messages_created_at").on(table.createdAt),
    index("idx_messages_run_id").on(table.runId)
  ]
);

export const runStatuses = ["running", "completed", "aborted", "error"] as const;

export type RunStatus = (typeof runStatuses)[number];

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    status: text("status", { enum: runStatuses }).notNull().default("running"),
    /** "providerId:modelId"。 */
    model: text("model"),
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
    index("idx_runs_status").on(table.status)
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
    args: text("args").notNull(), // JSON
    status: text("status", { enum: ["pending", "granted", "denied"] })
      .notNull()
      .default("pending"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    decidedAt: text("decided_at")
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
