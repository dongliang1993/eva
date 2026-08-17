import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type {
  AppSettings,
  ModelSummary,
  Provider,
  ProviderModel,
  ProviderType
} from "@eva/shared";

import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import { providers, settings } from "../db/schema.js";

const SETTINGS_BLOCK_KEYS = [
  "general",
  "chat",
  "security",
  "memory",
  "toolModel",
  "webSearch"
] as const;

type SettingsBlockKey = (typeof SETTINGS_BLOCK_KEYS)[number];

interface ProviderUpdateInput {
  readonly name?: string;
  readonly type?: ProviderType;
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
  readonly baseURL?: string;
  readonly enabled?: boolean;
  readonly models?: readonly ProviderModel[];
  readonly availableModels?: readonly ProviderModel[];
}

interface ProviderCreateInput {
  readonly id?: string;
  readonly name: string;
  readonly type: ProviderType;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly enabled?: boolean;
  readonly models?: readonly ProviderModel[];
  readonly availableModels?: readonly ProviderModel[];
}

export interface StoredProviderConfig extends Provider {
  apiKey: string;
}

const OPENAI_AVAILABLE_MODELS: readonly ProviderModel[] = [
  {
    id: "gpt-4.1",
    name: "gpt-4.1",
    capabilities: { contextWindow: 1_000_000, functionCalling: true, streaming: true }
  },
  {
    id: "gpt-4.1-mini",
    name: "gpt-4.1-mini",
    capabilities: { contextWindow: 1_000_000, functionCalling: true, streaming: true }
  },
  {
    id: "gpt-4o",
    name: "gpt-4o",
    capabilities: { contextWindow: 128_000, functionCalling: true, streaming: true, vision: true }
  },
  {
    id: "o3",
    name: "o3",
    capabilities: { contextWindow: 200_000, functionCalling: true, streaming: true, reasoning: true }
  }
] as const;

const ANTHROPIC_AVAILABLE_MODELS: readonly ProviderModel[] = [
  {
    id: "claude-opus-4-6",
    name: "claude-opus-4-6",
    capabilities: { contextWindow: 200_000, functionCalling: true, streaming: true, vision: true }
  },
  {
    id: "claude-sonnet-4-6",
    name: "claude-sonnet-4-6",
    capabilities: { contextWindow: 200_000, functionCalling: true, streaming: true, vision: true }
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "claude-haiku-4-5-20251001",
    capabilities: { contextWindow: 200_000, functionCalling: true, streaming: true }
  }
] as const;

const SEED_PROVIDERS: readonly typeof providers.$inferInsert[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    type: "anthropic",
    description: "Claude models from Anthropic",
    icon: "A",
    enabled: "false",
    apiKey: "",
    baseUrl: "",
    baseUrlPlaceholder: "https://api.anthropic.com",
    baseUrlHint: "Leave empty to use the default Anthropic API endpoint",
    apiKeyHint: "Get your API key from Anthropic Console",
    models: JSON.stringify(ANTHROPIC_AVAILABLE_MODELS.filter((model) =>
      model.id === "claude-sonnet-4-6"
    )),
    availableModels: JSON.stringify(ANTHROPIC_AVAILABLE_MODELS)
  },
  {
    id: "openai",
    name: "OpenAI",
    type: "openai",
    description: "GPT models from OpenAI",
    icon: "G",
    enabled: "false",
    apiKey: "",
    baseUrl: "",
    baseUrlPlaceholder: "https://api.openai.com/v1",
    baseUrlHint: "Leave empty to use the default OpenAI API endpoint",
    apiKeyHint: "Get your API key from OpenAI Platform",
    models: JSON.stringify(OPENAI_AVAILABLE_MODELS.filter((model) =>
      model.id === "gpt-4.1-mini"
    )),
    availableModels: JSON.stringify(OPENAI_AVAILABLE_MODELS)
  }
] as const;

const CHAT_RUNTIME_PROVIDER_TYPES = new Set<ProviderType>([
  "openai",
  "anthropic"
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeLogLevel = (
  value: string
): AppSettings["security"]["logLevel"] => {
  switch (value) {
    case "error":
    case "fatal":
    case "silent":
      return "error";
    case "warn":
      return "warn";
    case "debug":
    case "trace":
      return "debug";
    default:
      return "info";
  }
};


export const qualifyModelId = (
  value: string,
  fallbackProviderId?: string
): string => {
  if (!value || value.includes(":")) {
    return value;
  }

  if (value.startsWith("claude")) {
    return `anthropic:${value}`;
  }

  if (value.startsWith("gpt") || value.startsWith("o")) {
    return `openai:${value}`;
  }

  return fallbackProviderId ? `${fallbackProviderId}:${value}` : value;
};

export const splitQualifiedModelId = (
  value: string
): { providerId: string; modelId: string } | undefined => {
  const separatorIndex = value.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    return undefined;
  }

  return {
    providerId: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 1)
  };
};

const createDefaultSettings = (config: AppConfig): AppSettings => ({
  general: {
    language: "en",
    theme: "system"
  },
  chat: {
    defaultModel: "openai:gpt-4.1-mini",
    temperature: 0.1,
    streamResponse: true,
    autoSaveHistory: true,
    historyRetentionDays: 365,
    showTokenUsage: false,
    enableMarkdown: true,
    modelUsageHistory: {},
    defaultToolSelection: "auto",
    defaultSkillSelection: "auto",
    autoCompact: true,
    autoCompactTokenThreshold: 80_000,
    autoCompactMessageThreshold: 30
  },
  security: {
    encryptApiKeys: false,
    requirePassword: false,
    sessionTimeout: 0,
    enableLogging: true,
    logLevel: normalizeLogLevel(config.LOG_LEVEL),
    autoApproveToolRequests: false
  },
  memory: {
    enabled: true,
    autoSummarize: false,
    autoRetrieve: true,
    queryRewriting: false,
    maxRetrievedMemories: 5,
    similarityThreshold: 0.4,
    embedding: {
      baseUrl: "",
      apiKey: "",
      model: ""
    }
  },
  toolModel: {},
  webSearch: {
    engine: "google"
  }
});

const cloneSettings = (value: AppSettings): AppSettings => ({
  general: { ...value.general },
  chat: {
    ...value.chat,
    modelUsageHistory: { ...value.chat.modelUsageHistory }
  },
  security: { ...value.security },
  memory: { ...value.memory },
  toolModel: { ...value.toolModel },
  webSearch: { ...value.webSearch }
});

const parseJsonValue = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const parseContextWindow = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim().toUpperCase();
  const match = /^(\d+(?:\.\d+)?)([KM])?$/.exec(trimmed);

  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  if (!Number.isFinite(amount)) {
    return undefined;
  }

  switch (unit) {
    case "M":
      return Math.round(amount * 1_000_000);
    case "K":
      return Math.round(amount * 1_000);
    default:
      return Math.round(amount);
  }
};

const normalizeProviderModel = (value: unknown): ProviderModel | undefined => {
  if (!isRecord(value) || typeof value.id !== "string") {
    return undefined;
  }

  const capabilities: NonNullable<ProviderModel["capabilities"]> = {};

  if (isRecord(value.capabilities)) {
    if (typeof value.capabilities.vision === "boolean") {
      capabilities.vision = value.capabilities.vision;
    }

    if (typeof value.capabilities.imageOutput === "boolean") {
      capabilities.imageOutput = value.capabilities.imageOutput;
    }

    if (typeof value.capabilities.functionCalling === "boolean") {
      capabilities.functionCalling = value.capabilities.functionCalling;
    }

    if (typeof value.capabilities.functionCallingViaXml === "boolean") {
      capabilities.functionCallingViaXml = value.capabilities.functionCallingViaXml;
    }

    if (typeof value.capabilities.jsonMode === "boolean") {
      capabilities.jsonMode = value.capabilities.jsonMode;
    }

    if (typeof value.capabilities.streaming === "boolean") {
      capabilities.streaming = value.capabilities.streaming;
    }

    if (typeof value.capabilities.reasoning === "boolean") {
      capabilities.reasoning = value.capabilities.reasoning;
    }

    const parsedContextWindow = parseContextWindow(value.capabilities.contextWindow);

    if (parsedContextWindow !== undefined) {
      capabilities.contextWindow = parsedContextWindow;
    }

    if (typeof value.capabilities.maxOutputTokens === "number") {
      capabilities.maxOutputTokens = value.capabilities.maxOutputTokens;
    }
  }

  const legacyContextWindow = parseContextWindow(value.contextWindow);
  const mergedCapabilities = Object.keys(capabilities).length > 0
    ? capabilities
    : legacyContextWindow !== undefined
      ? { contextWindow: legacyContextWindow }
      : undefined;

  return {
    id: value.id,
    name: typeof value.name === "string" && value.name.length > 0 ? value.name : value.id,
    ...(mergedCapabilities !== undefined ? { capabilities: mergedCapabilities } : {}),
    ...(typeof value.isManual === "boolean" ? { isManual: value.isManual } : {}),
    ...(isRecord(value.providerOptions) ? { providerOptions: value.providerOptions } : {})
  };
};

const parseModelList = (value: string): readonly ProviderModel[] => {
  const parsed = parseJsonValue(value);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((item) => normalizeProviderModel(item))
    .filter((item): item is ProviderModel => item !== undefined);
};

const parseLegacyEnabledModelList = (value: string): readonly ProviderModel[] => {
  const parsed = parseJsonValue(value);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter((item) => !isRecord(item) || item.enabled !== false)
    .map((item) => normalizeProviderModel(item))
    .filter((item): item is ProviderModel => item !== undefined);
};

const normalizeProviderId = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || randomUUID();
};

const ensureUniqueProviderId = (db: AppDatabase, candidate: string): string => {
  const normalized = normalizeProviderId(candidate);
  const existing = db.select().from(providers).where(eq(providers.id, normalized)).get();

  if (!existing) {
    return normalized;
  }

  return `${normalized}-${randomUUID().slice(0, 8)}`;
};

const serializeModels = (value: readonly ProviderModel[] | undefined): string | undefined =>
  value !== undefined ? JSON.stringify(value) : undefined;

const parseProviderRow = (
  row: typeof providers.$inferSelect
): Provider => {
  const availableModels = parseModelList(row.availableModels);
  const hasSeparateAvailableModels = availableModels.length > 0;
  const enabledModels = hasSeparateAvailableModels
    ? parseModelList(row.models)
    : parseLegacyEnabledModelList(row.models);
  const fallbackAvailableModels = hasSeparateAvailableModels
    ? availableModels
    : parseModelList(row.models);

  return {
    id: row.id,
    name: row.name,
    type: row.type as ProviderType,
    models: enabledModels,
    availableModels: fallbackAvailableModels,
    hasApiKey: row.apiKey.length > 0,
    ...(row.baseUrl ? { baseURL: row.baseUrl } : {}),
    enabled: row.enabled === "true",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
};

const parseStoredProviderRow = (
  row: typeof providers.$inferSelect
): StoredProviderConfig => ({
  ...parseProviderRow(row),
  apiKey: row.apiKey
});

export const ensureProvidersSeeded = (db: AppDatabase): void => {
  const existing = db.select().from(providers).all();

  if (existing.length > 0) {
    return;
  }

  for (const provider of SEED_PROVIDERS) {
    db.insert(providers).values(provider).run();
  }
};


export const loadAppSettings = (
  db: AppDatabase,
  config: AppConfig
): AppSettings => {
  const current = cloneSettings(createDefaultSettings(config));
  const rows = db.select().from(settings).all();

  for (const row of rows) {
    const key = row.key as SettingsBlockKey;

    if ((SETTINGS_BLOCK_KEYS as readonly string[]).includes(row.key)) {
      const parsed = parseJsonValue(row.value);

      if (isRecord(parsed)) {
        switch (key) {
          case "general":
            current.general = {
              ...current.general,
              ...parsed
            } as AppSettings["general"];
            break;
          case "chat":
            current.chat = {
              ...current.chat,
              ...parsed,
              ...(isRecord(parsed.modelUsageHistory)
                ? { modelUsageHistory: parsed.modelUsageHistory as Record<string, number> }
                : {})
            } as AppSettings["chat"];
            break;
          case "security":
            current.security = {
              ...current.security,
              ...parsed
            } as AppSettings["security"];
            break;
          case "memory": {
            const parsedEmbedding = isRecord((parsed as Record<string, unknown>).embedding)
              ? (parsed as Record<string, unknown>).embedding as Record<string, unknown>
              : undefined;
            current.memory = {
              ...current.memory,
              ...parsed,
              embedding: {
                ...current.memory.embedding,
                ...(parsedEmbedding ?? {})
              }
            } as AppSettings["memory"];
            break;
          }
          case "toolModel":
            current.toolModel = {
              ...current.toolModel,
              ...parsed
            } as AppSettings["toolModel"];
            break;
          case "webSearch":
            current.webSearch = {
              ...current.webSearch,
              ...parsed
            } as AppSettings["webSearch"];
            break;
        }
      }

      continue;
    }

    if (row.key === "llm_model") {
      current.chat.defaultModel = qualifyModelId(row.value);
      continue;
    }

    if (row.key === "log_level") {
      current.security.logLevel = normalizeLogLevel(row.value);
      continue;
    }

    if (row.key === "model") {
      const parsed = parseJsonValue(row.value);

      if (isRecord(parsed) && typeof parsed.id === "string") {
        current.chat.defaultModel = qualifyModelId(parsed.id);
      } else if (typeof row.value === "string") {
        current.chat.defaultModel = qualifyModelId(row.value);
      }
    }
  }

  current.chat.defaultModel = qualifyModelId(current.chat.defaultModel);

  return current;
};

export const replaceAppSettings = (
  db: AppDatabase,
  config: AppConfig,
  next: AppSettings
): AppSettings => {
  db.delete(settings).run();

  for (const key of SETTINGS_BLOCK_KEYS) {
    db.insert(settings).values({
      key,
      value: JSON.stringify(next[key])
    }).run();
  }

  return loadAppSettings(db, config);
};

export const listProviders = (db: AppDatabase): readonly Provider[] => {
  ensureProvidersSeeded(db);

  return db.select().from(providers).all().map(parseProviderRow);
};

export const findProviderById = (
  db: AppDatabase,
  id: string
): Provider | undefined => {
  ensureProvidersSeeded(db);

  const row = db.select().from(providers).where(eq(providers.id, id)).get();

  return row ? parseProviderRow(row) : undefined;
};

export const findStoredProviderById = (
  db: AppDatabase,
  id: string
): StoredProviderConfig | undefined => {
  ensureProvidersSeeded(db);

  const row = db.select().from(providers).where(eq(providers.id, id)).get();

  return row ? parseStoredProviderRow(row) : undefined;
};

export const createProvider = (
  db: AppDatabase,
  input: ProviderCreateInput
): Provider => {
  ensureProvidersSeeded(db);

  const id = ensureUniqueProviderId(db, input.id ?? input.name);
  const timestamp = new Date().toISOString();
  const models = input.models ?? [];
  const availableModels = input.availableModels ?? models;

  db.insert(providers).values({
    id,
    name: input.name,
    type: input.type,
    enabled: input.enabled === true ? "true" : "false",
    apiKey: input.apiKey ?? "",
    baseUrl: input.baseURL ?? "",
    models: JSON.stringify(models),
    availableModels: JSON.stringify(availableModels),
    createdAt: timestamp,
    updatedAt: timestamp
  }).run();

  return findProviderById(db, id)!;
};

export const updateProvider = (
  db: AppDatabase,
  id: string,
  input: ProviderUpdateInput
): Provider | undefined => {
  ensureProvidersSeeded(db);

  const existing = db.select().from(providers).where(eq(providers.id, id)).get();

  if (!existing) {
    return undefined;
  }

  const updates: Partial<typeof providers.$inferInsert> = {
    updatedAt: new Date().toISOString()
  };

  if (input.name !== undefined) {
    updates.name = input.name;
  }

  if (input.type !== undefined) {
    updates.type = input.type;
  }

  if (input.enabled !== undefined) {
    updates.enabled = input.enabled ? "true" : "false";
  }

  if (input.baseURL !== undefined) {
    updates.baseUrl = input.baseURL;
  }

  if (input.apiKey !== undefined) {
    updates.apiKey = input.apiKey;
  } else if (input.clearApiKey) {
    updates.apiKey = "";
  }

  if (input.models !== undefined) {
    updates.models = serializeModels(input.models);
  }

  if (input.availableModels !== undefined) {
    updates.availableModels = serializeModels(input.availableModels);
  }

  db.update(providers).set(updates).where(eq(providers.id, id)).run();

  return findProviderById(db, id);
};

export const deleteProvider = (db: AppDatabase, id: string): boolean => {
  ensureProvidersSeeded(db);

  const result = db.delete(providers).where(eq(providers.id, id)).run();
  return result.changes > 0;
};

const qualifyProviderModelId = (providerId: string, modelId: string): string =>
  modelId.startsWith(`${providerId}:`) ? modelId : `${providerId}:${modelId}`;

export const listModelSummaries = (db: AppDatabase): readonly ModelSummary[] =>
  listProviders(db)
    .filter((provider) => provider.enabled && CHAT_RUNTIME_PROVIDER_TYPES.has(provider.type))
    .flatMap((provider) =>
      provider.models.map((model) => ({
        id: qualifyProviderModelId(provider.id, model.id),
        name: model.name,
        provider: provider.name,
        providerId: provider.id,
        ...(model.capabilities !== undefined ? { capabilities: model.capabilities } : {})
      }))
    );
