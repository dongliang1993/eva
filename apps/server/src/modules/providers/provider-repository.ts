import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type {
  Provider,
  ProviderModel,
  ProviderModelCapabilities,
  ProviderType
} from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import { providers } from "../../db/schema.js";
import {
  IdentityEncryptor,
  type Encryptor,
} from "../../infrastructure/crypto/encryptor.js";
import { PROVIDER_CATALOG } from "./provider-catalog.js";

/** 缺省 = 明文直通(无加密版行为);装配了 AES 的调用方从 app.infra.encryptor 传进来。 */
const PLAINTEXT: Encryptor = new IdentityEncryptor();

export interface StoredProviderConfig extends Provider {
  apiKey: string;
}

export interface ProviderUpdateInput {
  readonly name?: string;
  readonly type?: ProviderType;
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
  readonly baseURL?: string;
  readonly enabled?: boolean;
  readonly models?: readonly ProviderModel[];
  readonly availableModels?: readonly ProviderModel[];
}

export interface ProviderCreateInput {
  readonly id?: string;
  readonly name: string;
  readonly type: ProviderType;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly enabled?: boolean;
  readonly models?: readonly ProviderModel[];
  readonly availableModels?: readonly ProviderModel[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseContextWindow = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;

  const match = /^(\d+(?:\.\d+)?)([KM])?$/.exec(value.trim().toUpperCase());
  if (!match) return undefined;

  const amount = Number(match[1]);
  const unit = match[2];

  if (!Number.isFinite(amount)) return undefined;
  switch (unit) {
    case "M":
      return Math.round(amount * 1_000_000);
    case "K":
      return Math.round(amount * 1_000);
    default:
      return Math.round(amount);
  }
};

const parseJsonValue = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

export const normalizeProviderModel = (value: unknown): ProviderModel | undefined => {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;

  const capabilities: NonNullable<ProviderModel["capabilities"]> = {};
  if (isRecord(value.capabilities)) {
    const c = value.capabilities;
    if (typeof c.vision === "boolean") capabilities.vision = c.vision;
    if (typeof c.imageOutput === "boolean") capabilities.imageOutput = c.imageOutput;
    if (typeof c.functionCalling === "boolean") capabilities.functionCalling = c.functionCalling;
    if (typeof c.functionCallingViaXml === "boolean") capabilities.functionCallingViaXml = c.functionCallingViaXml;
    if (typeof c.jsonMode === "boolean") capabilities.jsonMode = c.jsonMode;
    if (typeof c.streaming === "boolean") capabilities.streaming = c.streaming;
    if (typeof c.reasoning === "boolean") capabilities.reasoning = c.reasoning;

    const contextWindow = parseContextWindow(c.contextWindow);
    if (contextWindow !== undefined) capabilities.contextWindow = contextWindow;
    if (typeof c.maxOutputTokens === "number") capabilities.maxOutputTokens = c.maxOutputTokens;
  }

  const legacyContextWindow = parseContextWindow(value.contextWindow);
  const merged = Object.keys(capabilities).length > 0
    ? capabilities
    : legacyContextWindow !== undefined
      ? { contextWindow: legacyContextWindow }
      : undefined;

  return {
    id: value.id,
    name: typeof value.name === "string" && value.name.length > 0 ? value.name : value.id,
    ...(merged !== undefined ? { capabilities: merged as ProviderModelCapabilities } : {}),
    ...(typeof value.isManual === "boolean" ? { isManual: value.isManual } : {}),
    ...(isRecord(value.providerOptions) ? { providerOptions: value.providerOptions } : {})
  };
};

export const parseModelList = (value: string): readonly ProviderModel[] => {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(normalizeProviderModel)
    .filter((m): m is ProviderModel => m !== undefined);
};

const parseLegacyEnabledModelList = (value: string): readonly ProviderModel[] => {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item) => !isRecord(item) || item.enabled !== false)
    .map(normalizeProviderModel)
    .filter((m): m is ProviderModel => m !== undefined);
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
  return existing ? `${normalized}-${randomUUID().slice(0, 8)}` : normalized;
};

const serializeModels = (value: readonly ProviderModel[] | undefined): string | undefined =>
  value !== undefined ? JSON.stringify(value) : undefined;

export const parseProviderRow = (row: typeof providers.$inferSelect): Provider => {
  const availableModels = parseModelList(row.availableModels);
  const enabledModels = availableModels.length > 0
    ? parseModelList(row.models)
    : parseLegacyEnabledModelList(row.models);
  const fallbackAvailable = availableModels.length > 0 ? availableModels : parseModelList(row.models);

  return {
    id: row.id,
    name: row.name,
    type: row.type as ProviderType,
    models: enabledModels,
    availableModels: fallbackAvailable,
    hasApiKey: row.apiKey.length > 0,
    ...(row.baseUrl ? { baseURL: row.baseUrl } : {}),
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
};

/**
 * 含 apiKey 的服务端内部版。解密只在这里发生 ——
 * `parseProviderRow`(UI 版)刻意不含 apiKey,给它接解密等于把明文 key
 * 送到了原本拿不到它的路径(坑 2)。
 */
export const parseStoredProviderRow = (
  row: typeof providers.$inferSelect,
  encryptor: Encryptor = PLAINTEXT
): StoredProviderConfig => ({
  ...parseProviderRow(row),
  apiKey: encryptor.decrypt(row.apiKey)
});

/**
 * seed 遍历 catalog:每个 spec 一条 disabled provider,models=[]、
 * availableModels = spec.builtinModels。
 */
export const ensureProvidersSeeded = (db: AppDatabase): void => {
  const existing = db.select().from(providers).all();
  if (existing.length > 0) return;

  for (const spec of PROVIDER_CATALOG) {
    // anthropic/openai 额外带一条默认勾选的模型作为兜底(与旧 seed 行为一致)。
    const defaultModels = spec.type === "anthropic"
      ? spec.builtinModels.filter((m) => m.id === "claude-sonnet-4-6")
      : spec.type === "openai"
        ? spec.builtinModels.filter((m) => m.id === "gpt-4.1-mini")
        : [];

    db.insert(providers).values({
      id: spec.type,
      name: spec.label,
      type: spec.type,
      enabled: false,
      apiKey: "",
      baseUrl: "",
      models: JSON.stringify(defaultModels),
      availableModels: JSON.stringify(spec.builtinModels)
    }).run();
  }
};

export const findStoredProviderById = (
  db: AppDatabase,
  id: string,
  encryptor?: Encryptor
): StoredProviderConfig | undefined => {
  ensureProvidersSeeded(db);
  const row = db.select().from(providers).where(eq(providers.id, id)).get();
  return row ? parseStoredProviderRow(row, encryptor) : undefined;
};

export const findProviderById = (db: AppDatabase, id: string): Provider | undefined => {
  ensureProvidersSeeded(db);
  const row = db.select().from(providers).where(eq(providers.id, id)).get();
  return row ? parseProviderRow(row) : undefined;
};

export const listProviders = (db: AppDatabase): readonly Provider[] => {
  ensureProvidersSeeded(db);
  return db.select().from(providers).all().map(parseProviderRow);
};

export const createProvider = (
  db: AppDatabase,
  input: ProviderCreateInput,
  encryptor: Encryptor = PLAINTEXT
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
    enabled: input.enabled === true,
    // 空串直通(不加密)= "没配 key" 的语义锚点(坑 1)
    apiKey: input.apiKey ? encryptor.encrypt(input.apiKey) : "",
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
  input: ProviderUpdateInput,
  encryptor: Encryptor = PLAINTEXT
): Provider | undefined => {
  ensureProvidersSeeded(db);
  const existing = db.select().from(providers).where(eq(providers.id, id)).get();
  if (!existing) return undefined;

  const updates: Partial<typeof providers.$inferInsert> = {
    updatedAt: new Date().toISOString()
  };
  if (input.name !== undefined) updates.name = input.name;
  if (input.type !== undefined) updates.type = input.type;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.baseURL !== undefined) updates.baseUrl = input.baseURL;
  // 只有 key 被显式 update 时才加密(懒迁移的触发点);clearApiKey 写 "" 直通
  if (input.apiKey !== undefined) updates.apiKey = encryptor.encrypt(input.apiKey);
  else if (input.clearApiKey) updates.apiKey = "";
  if (input.models !== undefined) updates.models = serializeModels(input.models);
  if (input.availableModels !== undefined) updates.availableModels = serializeModels(input.availableModels);

  db.update(providers).set(updates).where(eq(providers.id, id)).run();
  return findProviderById(db, id);
};

export const deleteProvider = (db: AppDatabase, id: string): boolean => {
  ensureProvidersSeeded(db);
  const result = db.delete(providers).where(eq(providers.id, id)).run();
  return result.changes > 0;
};
