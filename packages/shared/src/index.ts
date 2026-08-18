import type { StreamTokenUsage } from "./stream-events.js";

export type UnknownRecord = Record<string, unknown>;

/**
 * 只保留真正被 runtime 支持的 provider 类型。google/azure 需要各自的 @ai-sdk/* 包,
 * copilot/acp/... 是特殊鉴权流从未实现 —— 要支持就正经加(见 services/providers/provider-catalog.ts)。
 */
export type ProviderType =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "openrouter"
  | "moonshot"
  | "aihubmix"
  | "custom";

/** 决定用哪个 AI SDK 工厂 + 哪套 HTTP 探活协议。 */
export type ProviderKind = "openai-compatible" | "anthropic";

export interface ProviderModelCapabilities {
  vision?: boolean;
  imageOutput?: boolean;
  functionCalling?: boolean;
  functionCallingViaXml?: boolean;
  jsonMode?: boolean;
  streaming?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ProviderModel {
  id: string;
  name: string;
  capabilities?: ProviderModelCapabilities;
  isManual?: boolean;
  providerOptions?: Record<string, unknown>;
}

/** provider 的静态知识(数据在 server 的 catalog,类型放 shared 供前端消费)。 */
export interface ProviderSpec {
  readonly type: ProviderType;
  readonly label: string;
  readonly kind: ProviderKind;
  /** 缺省 baseURL;undefined = 必须由用户显式填。 */
  readonly defaultBaseURL?: string;
  readonly baseURLPlaceholder?: string;
  readonly apiKeyHint?: string;
  /** 内置模型目录 —— 用户没拉过模型列表时的兜底。 */
  readonly builtinModels: readonly ProviderModel[];
}

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  models: readonly ProviderModel[];
  availableModels: readonly ProviderModel[];
  hasApiKey: boolean;
  baseURL?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 哪个模型干哪件事。 */
export type ModelSlot = "chat" | "tool" | "embedding";

export interface ModelSlotSettings {
  /** 主对话。必填。 */
  readonly chat: string;
  /** 杂务档(compact 摘要 / web-fetch 摘要);缺省回落 chat。 */
  readonly tool?: string;
  /** 记忆向量;缺省 = 语义检索禁用,降级为纯 FTS。 */
  readonly embedding?: string;
}

export interface ProviderConnectionTestResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ProviderModelsPayload {
  data: readonly string[];
  models: readonly ProviderModel[];
}

export interface ModelSummary {
  id: string;
  name: string;
  provider: string;
  providerId: string;
  capabilities?: ProviderModelCapabilities;
}

export interface AppSettings {
  /** 三个模型槽位 —— "哪个模型干哪件事"的唯一事实源。 */
  models: ModelSlotSettings;
  chat: {
    temperature: number;
    autoCompact: boolean;
    autoCompactTokenThreshold: number;
    autoCompactMessageThreshold: number;
  };
  memory: {
    enabled: boolean;
    autoSummarize: boolean;
    autoRetrieve: boolean;
    queryRewriting: boolean;
    maxRetrievedMemories: number;
    similarityThreshold: number;
  };
  security: {
    logLevel: "error" | "warn" | "info" | "debug";
    autoApproveToolRequests: boolean;
  };
}

export interface HealthStatus {
  status: "ok";
  timestamp: string;
}

export interface ThreadSummary {
  id: string;
  title: string;
  model: string | null;
  origin: string;
  updatedAt: string;
  messageCount: number;
  workspaceId: string | null;
  status: SessionStatus;
}

/** 会话状态 —— 算出来的,不是存下来的(docs 14 §5.2 原则 8)。 */
export type SessionStatus = "requires_action" | "running" | "idle";

/** run 终态。与 server 侧 schema.RunStatus 结构一致(runs 表)。 */
export type RunStatus = "running" | "completed" | "aborted" | "error";

export interface PendingApprovalSummary {
  callId: string;
  toolName: string;
  args: unknown;
}

export interface ThreadStatus {
  status: SessionStatus;
  activeRunId: string | null;
  pendingApprovals: readonly PendingApprovalSummary[];
}

export interface ThreadUsage {
  /** 当前模型可见历史(含摘要)的估算。 */
  contextTokens: number;
  /** chat 槽位模型的窗口;未知则 null。 */
  contextWindow: number | null;
  /** contextTokens / contextWindow;只有后者非 null 时才有。 */
  contextRatio: number | null;
  runCount: number;
  /** 该会话所有 run 的用量累加。 */
  totalUsage: StreamTokenUsage;
  lastRun: {
    id: string;
    status: RunStatus;
    finishReason: string | null;
    endedAt: string | null;
  } | null;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInput {
  path: string;
  name?: string;
}

export interface ThreadSearchResult {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  snippet?: string;
}

import type { EvaUIMessage } from "./ui-message.js";

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  message: EvaUIMessage;
  runId: string | null;
  createdAt: string;
}

export type MemoryCategory =
  | "user"
  | "preference"
  | "project"
  | "decision"
  | "knowledge";

export type MemoryOrigin = "manual" | "tool_saved";

export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  origin: MemoryOrigin;
  content: string;
  metadata: string;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStats {
  count: number;
  autoGenerated: number;
  manualAdded: number;
  byCategory: Record<MemoryCategory, number>;
  embedding: {
    ready: number;
    pending: number;
  };
}

export type SkillSource = "bundled" | "project";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  enabled: boolean;
}

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

export const toRecord = (value: unknown): UnknownRecord =>
  isRecord(value) ? value : {};

export const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

export const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

export * from "./stream-events.js";
export * from "./ui-message.js";
export * from "./ui-message-builder.js";
export * from "./mcp.js";
