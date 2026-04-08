import type {
  ProviderConnectionTestResult,
  ProviderModel,
  ProviderModelsPayload,
  ProviderType
} from "@eva/shared";

import type { StoredProviderConfig } from "./settings-store.js";

export interface ProviderRuntimeOverrides {
  readonly apiKey?: string;
  readonly baseURL?: string;
}

export class ProviderRuntimeError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "ProviderRuntimeError";
  }
}

type ProviderTransport = "openai-compatible" | "anthropic" | "google" | "azure";

interface ProviderRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly transport: ProviderTransport;
}

const DEFAULT_BASE_URLS: Partial<Record<ProviderType, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.cn/v1"
};

const OPENAI_COMPATIBLE_TYPES = new Set<ProviderType>([
  "openai",
  "aihubmix",
  "openrouter",
  "deepseek",
  "copilot",
  "moonshot",
  "custom",
  "acp",
  "claude-subscription",
  "zai-coding-plan",
  "kimi-coding-plan"
]);

const toNonEmptyString = (value?: string): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const trimTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/, "");

const toPositiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;

const toModelName = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;

const resolveProviderApiKey = (
  provider: StoredProviderConfig,
  overrides?: ProviderRuntimeOverrides
): string => {
  const apiKey = toNonEmptyString(overrides?.apiKey) ?? toNonEmptyString(provider.apiKey);

  if (!apiKey) {
    throw new ProviderRuntimeError("Provider API key is not configured");
  }

  return apiKey;
};

const resolveProviderBaseUrl = (
  provider: StoredProviderConfig,
  overrides?: ProviderRuntimeOverrides
): string => {
  const baseURL = toNonEmptyString(overrides?.baseURL)
    ?? toNonEmptyString(provider.baseURL)
    ?? DEFAULT_BASE_URLS[provider.type];

  if (!baseURL) {
    throw new ProviderRuntimeError("Provider base URL is not configured");
  }

  return trimTrailingSlashes(baseURL);
};

const resolveProviderTransport = (type: ProviderType): ProviderTransport => {
  if (type === "anthropic") {
    return "anthropic";
  }

  if (type === "google") {
    return "google";
  }

  if (type === "azure") {
    return "azure";
  }

  if (OPENAI_COMPATIBLE_TYPES.has(type)) {
    return "openai-compatible";
  }

  throw new ProviderRuntimeError(`Provider type "${type}" is not supported yet`);
};

const joinUrlPath = (baseURL: string, suffix: string): string =>
  `${trimTrailingSlashes(baseURL)}${suffix}`;

const buildAzureModelsUrl = (baseURL: string): string => {
  const normalized = trimTrailingSlashes(baseURL).replace(/\/models$/, "");
  const azureBase = normalized.endsWith("/openai")
    ? normalized
    : `${normalized}/openai`;

  return `${azureBase}/models?api-version=2024-10-21`;
};

const buildProviderModelsRequest = (
  provider: StoredProviderConfig,
  overrides?: ProviderRuntimeOverrides
): ProviderRequest => {
  const transport = resolveProviderTransport(provider.type);
  const apiKey = resolveProviderApiKey(provider, overrides);
  const baseURL = resolveProviderBaseUrl(provider, overrides);

  switch (transport) {
    case "anthropic":
      return {
        url: joinUrlPath(baseURL.replace(/\/v1$/, ""), "/v1/models"),
        init: {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          signal: AbortSignal.timeout(10_000)
        },
        transport
      };
    case "google":
      return {
        url: `${joinUrlPath(baseURL.replace(/\/models$/, ""), "/models")}?key=${encodeURIComponent(apiKey)}`,
        init: {
          method: "GET",
          signal: AbortSignal.timeout(10_000)
        },
        transport
      };
    case "azure":
      return {
        url: buildAzureModelsUrl(baseURL),
        init: {
          method: "GET",
          headers: {
            "api-key": apiKey
          },
          signal: AbortSignal.timeout(10_000)
        },
        transport
      };
    case "openai-compatible":
      return {
        url: joinUrlPath(baseURL.replace(/\/models$/, ""), "/models"),
        init: {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`
          },
          signal: AbortSignal.timeout(10_000)
        },
        transport
      };
  }
};

const mergeCapabilities = (
  existing?: ProviderModel["capabilities"],
  next?: ProviderModel["capabilities"]
): ProviderModel["capabilities"] | undefined => {
  const merged = {
    ...(existing ?? {}),
    ...(next ?? {})
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
};

const mergeProviderModels = (
  existing: ProviderModel | undefined,
  next: ProviderModel
): ProviderModel => {
  const capabilities = mergeCapabilities(existing?.capabilities, next.capabilities);
  const providerOptions = existing?.providerOptions || next.providerOptions
    ? { ...(existing?.providerOptions ?? {}), ...(next.providerOptions ?? {}) }
    : undefined;

  return {
    id: next.id,
    name: toModelName(next.name, existing?.name ?? next.id),
    ...(capabilities ? { capabilities } : {}),
    ...(next.isManual !== undefined
      ? { isManual: next.isManual }
      : existing?.isManual !== undefined
        ? { isManual: existing.isManual }
        : {}),
    ...(providerOptions ? { providerOptions } : {})
  };
};

const dedupeModels = (models: readonly ProviderModel[]): readonly ProviderModel[] => {
  const byId = new Map<string, ProviderModel>();

  for (const model of models) {
    const existing = byId.get(model.id);
    byId.set(model.id, existing ? mergeProviderModels(existing, model) : model);
  }

  return [...byId.values()];
};

const extractModelArray = (payload: unknown): readonly unknown[] => {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as {
    data?: unknown;
    models?: unknown;
  };

  if (Array.isArray(record.models)) {
    return record.models;
  }

  if (Array.isArray(record.data)) {
    return record.data;
  }

  return [];
};

const normalizeOpenAiCompatibleModel = (item: unknown): ProviderModel | undefined => {
  if (typeof item === "string" && item.length > 0) {
    return { id: item, name: item };
  }

  if (!item || typeof item !== "object") {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;

  if (!id) {
    return undefined;
  }

  const contextWindow = toPositiveInteger(record.contextWindow)
    ?? toPositiveInteger(record.context_window);
  const maxOutputTokens = toPositiveInteger(record.maxOutputTokens)
    ?? toPositiveInteger(record.max_output_tokens);
  const capabilities = {
    ...(typeof record.vision === "boolean" ? { vision: record.vision } : {}),
    ...(typeof record.functionCalling === "boolean"
      ? { functionCalling: record.functionCalling }
      : {}),
    ...(typeof record.streaming === "boolean" ? { streaming: record.streaming } : {}),
    ...(typeof record.reasoning === "boolean" ? { reasoning: record.reasoning } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
  };

  return {
    id,
    name: toModelName(record.name ?? record.display_name ?? record.displayName, id),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {})
  };
};

const normalizeAnthropicModel = (item: unknown): ProviderModel | undefined => {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;

  if (!id) {
    return undefined;
  }

  return {
    id,
    name: toModelName(record.display_name ?? record.name, id)
  };
};

const normalizeGoogleModel = (item: unknown): ProviderModel | undefined => {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  const rawName = typeof record.name === "string" ? record.name : undefined;

  if (!rawName) {
    return undefined;
  }

  const id = rawName.replace(/^models\//, "");
  const methods = Array.isArray(record.supportedGenerationMethods)
    ? record.supportedGenerationMethods.filter((value): value is string => typeof value === "string")
    : [];
  const contextWindow = toPositiveInteger(record.inputTokenLimit);
  const maxOutputTokens = toPositiveInteger(record.outputTokenLimit);
  const capabilities = {
    ...(methods.includes("streamGenerateContent") ? { streaming: true } : {}),
    ...(methods.includes("generateContent") ? { jsonMode: true } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
  };

  return {
    id,
    name: toModelName(record.displayName, id),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {})
  };
};

const normalizeResponseModels = (
  transport: ProviderTransport,
  payload: unknown
): readonly ProviderModel[] => {
  const source = extractModelArray(payload);

  switch (transport) {
    case "anthropic":
      return dedupeModels(
        source
          .map((item) => normalizeAnthropicModel(item))
          .filter((item): item is ProviderModel => item !== undefined)
      );
    case "google":
      return dedupeModels(
        source
          .map((item) => normalizeGoogleModel(item))
          .filter((item): item is ProviderModel => item !== undefined)
      );
    case "azure":
    case "openai-compatible":
      return dedupeModels(
        source
          .map((item) => normalizeOpenAiCompatibleModel(item))
          .filter((item): item is ProviderModel => item !== undefined)
      );
  }
};

const toProviderModelsPayload = (
  models: readonly ProviderModel[]
): ProviderModelsPayload => ({
  data: models.map((model) => model.id),
  models
});

const mergeFetchedModels = (
  provider: StoredProviderConfig,
  fetchedModels: readonly ProviderModel[]
): readonly ProviderModel[] => {
  const existingById = new Map(provider.availableModels.map((model) => [model.id, model]));
  const enabledById = new Map(provider.models.map((model) => [model.id, model]));

  const mergedFetched = fetchedModels.map((model) =>
    mergeProviderModels(existingById.get(model.id) ?? enabledById.get(model.id), model)
  );
  const nextById = new Map(mergedFetched.map((model) => [model.id, model]));

  for (const model of provider.availableModels) {
    if (model.isManual && !nextById.has(model.id)) {
      nextById.set(model.id, model);
    }
  }

  for (const model of provider.models) {
    if (!nextById.has(model.id)) {
      nextById.set(model.id, model);
    }
  }

  return [...nextById.values()];
};

const parseErrorMessage = async (response: Response): Promise<string> => {
  const body = await response.text().catch(() => "");

  if (!body) {
    return response.statusText || `HTTP ${response.status}`;
  }

  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      message?: unknown;
    };

    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }

    if (typeof parsed.message === "string" && parsed.message.length > 0) {
      return parsed.message;
    }
  } catch {
    // Ignore JSON parse failures and fall back to raw text.
  }

  return body;
};

const fetchDiscoveredModels = async (
  provider: StoredProviderConfig,
  overrides?: ProviderRuntimeOverrides
): Promise<readonly ProviderModel[]> => {
  const request = buildProviderModelsRequest(provider, overrides);

  let response: Response;
  try {
    response = await fetch(request.url, request.init);
  } catch (error) {
    throw new ProviderRuntimeError(
      error instanceof Error ? error.message : "Failed to reach provider API",
      502
    );
  }

  if (!response.ok) {
    throw new ProviderRuntimeError(await parseErrorMessage(response), response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderRuntimeError("Provider returned an invalid JSON response", 502);
  }

  return normalizeResponseModels(request.transport, payload);
};

export const listProviderModels = (
  provider: StoredProviderConfig
): ProviderModelsPayload =>
  toProviderModelsPayload(provider.availableModels);

export const discoverProviderModels = async (
  provider: StoredProviderConfig,
  overrides?: ProviderRuntimeOverrides
): Promise<ProviderModelsPayload> => {
  const fetchedModels = await fetchDiscoveredModels(provider, overrides);
  const mergedModels = mergeFetchedModels(provider, fetchedModels);
  return toProviderModelsPayload(mergedModels);
};

export const testProviderConnection = async (
  provider: StoredProviderConfig,
  overrides?: ProviderRuntimeOverrides
): Promise<ProviderConnectionTestResult> => {
  const startedAt = Date.now();

  try {
    await fetchDiscoveredModels(provider, overrides);
    return {
      success: true,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Provider connection test failed"
    };
  }
};
