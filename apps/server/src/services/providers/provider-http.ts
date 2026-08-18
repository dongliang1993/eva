import type {
  ProviderConnectionTestResult,
  ProviderModel,
  ProviderModelsPayload
} from "@eva/shared";

import type { StoredProviderConfig } from "./provider-repository.js";
import { findProviderSpec } from "./provider-catalog.js";

export interface ProviderHttpOverrides {
  readonly apiKey?: string;
  readonly baseURL?: string;
}

/** HTTP 层错误(不是"运行时"这种什么都能装的词)。 */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

const toNonEmptyString = (value?: string): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

const toPositiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const toModelName = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;

const resolveProviderApiKey = (
  provider: StoredProviderConfig,
  overrides?: ProviderHttpOverrides
): string => {
  const apiKey = toNonEmptyString(overrides?.apiKey) ?? toNonEmptyString(provider.apiKey);
  if (!apiKey) throw new ProviderHttpError("Provider API key is not configured");
  return apiKey;
};

/** baseURL 决议按 catalog spec:configured 优先,否则用 spec 默认。 */
const resolveBaseUrl = (
  provider: StoredProviderConfig,
  overrides?: ProviderHttpOverrides
): string => {
  const spec = findProviderSpec(provider.type);
  if (!spec) throw new ProviderHttpError(`Provider type "${provider.type}" is not supported`);

  const baseURL = toNonEmptyString(overrides?.baseURL)
    ?? toNonEmptyString(provider.baseURL)
    ?? spec.defaultBaseURL;

  if (!baseURL) {
    throw new ProviderHttpError("Provider base URL is not configured");
  }

  return trimTrailingSlashes(baseURL);
};

const joinUrlPath = (baseURL: string, suffix: string): string =>
  `${trimTrailingSlashes(baseURL)}${suffix}`;

interface ProviderRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly kind: "openai-compatible" | "anthropic";
}

const buildProviderModelsRequest = (
  provider: StoredProviderConfig,
  overrides?: ProviderHttpOverrides
): ProviderRequest => {
  const spec = findProviderSpec(provider.type);
  if (!spec) throw new ProviderHttpError(`Provider type "${provider.type}" is not supported`);

  const apiKey = resolveProviderApiKey(provider, overrides);
  const baseURL = resolveBaseUrl(provider, overrides);

  if (spec.kind === "anthropic") {
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
      kind: spec.kind
    };
  }

  return {
    url: joinUrlPath(baseURL.replace(/\/models$/, ""), "/models"),
    init: {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000)
    },
    kind: spec.kind
  };
};

const mergeCapabilities = (
  existing?: ProviderModel["capabilities"],
  next?: ProviderModel["capabilities"]
): ProviderModel["capabilities"] | undefined => {
  const merged = { ...(existing ?? {}), ...(next ?? {}) };
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
  if (!payload || typeof payload !== "object") return [];
  const record = payload as { data?: unknown; models?: unknown };
  if (Array.isArray(record.models)) return record.models;
  if (Array.isArray(record.data)) return record.data;
  return [];
};

const normalizeOpenAiCompatibleModel = (item: unknown): ProviderModel | undefined => {
  if (typeof item === "string" && item.length > 0) return { id: item, name: item };
  if (!item || typeof item !== "object") return undefined;

  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  if (!id) return undefined;

  const contextWindow = toPositiveInteger(record.contextWindow) ?? toPositiveInteger(record.context_window);
  const maxOutputTokens = toPositiveInteger(record.maxOutputTokens) ?? toPositiveInteger(record.max_output_tokens);
  const capabilities = {
    ...(typeof record.vision === "boolean" ? { vision: record.vision } : {}),
    ...(typeof record.functionCalling === "boolean" ? { functionCalling: record.functionCalling } : {}),
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
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  if (!id) return undefined;
  return { id, name: toModelName(record.display_name ?? record.name, id) };
};

const normalizeResponseModels = (
  kind: "openai-compatible" | "anthropic",
  payload: unknown
): readonly ProviderModel[] => {
  const source = extractModelArray(payload);
  const normalize = kind === "anthropic" ? normalizeAnthropicModel : normalizeOpenAiCompatibleModel;
  return dedupeModels(
    source.map(normalize).filter((m): m is ProviderModel => m !== undefined)
  );
};

const toProviderModelsPayload = (models: readonly ProviderModel[]): ProviderModelsPayload => ({
  data: models.map((model) => model.id),
  models
});

const mergeFetchedModels = (
  provider: StoredProviderConfig,
  fetchedModels: readonly ProviderModel[]
): readonly ProviderModel[] => {
  const existingById = new Map(provider.availableModels.map((m) => [m.id, m]));
  const enabledById = new Map(provider.models.map((m) => [m.id, m]));

  const mergedFetched = fetchedModels.map((m) =>
    mergeProviderModels(existingById.get(m.id) ?? enabledById.get(m.id), m)
  );
  const nextById = new Map(mergedFetched.map((m) => [m.id, m]));

  for (const model of provider.availableModels) {
    if (model.isManual && !nextById.has(model.id)) nextById.set(model.id, model);
  }
  for (const model of provider.models) {
    if (!nextById.has(model.id)) nextById.set(model.id, model);
  }

  return [...nextById.values()];
};

const parseErrorMessage = async (response: Response): Promise<string> => {
  const body = await response.text().catch(() => "");
  if (!body) return response.statusText || `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
    if (typeof parsed.message === "string" && parsed.message.length > 0) return parsed.message;
  } catch {
    // fall through to raw text
  }
  return body;
};

const fetchDiscoveredModels = async (
  provider: StoredProviderConfig,
  overrides?: ProviderHttpOverrides
): Promise<readonly ProviderModel[]> => {
  const request = buildProviderModelsRequest(provider, overrides);

  let response: Response;
  try {
    response = await fetch(request.url, request.init);
  } catch (error) {
    throw new ProviderHttpError(
      error instanceof Error ? error.message : "Failed to reach provider API",
      502
    );
  }

  if (!response.ok) {
    throw new ProviderHttpError(await parseErrorMessage(response), response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderHttpError("Provider returned an invalid JSON response", 502);
  }

  return normalizeResponseModels(request.kind, payload);
};

export const listProviderModels = (provider: StoredProviderConfig): ProviderModelsPayload =>
  toProviderModelsPayload(provider.availableModels);

export const discoverProviderModels = async (
  provider: StoredProviderConfig,
  overrides?: ProviderHttpOverrides
): Promise<ProviderModelsPayload> => {
  const fetchedModels = await fetchDiscoveredModels(provider, overrides);
  const mergedModels = mergeFetchedModels(provider, fetchedModels);
  return toProviderModelsPayload(mergedModels);
};

export const testProviderConnection = async (
  provider: StoredProviderConfig,
  overrides?: ProviderHttpOverrides
): Promise<ProviderConnectionTestResult> => {
  const startedAt = Date.now();
  try {
    await fetchDiscoveredModels(provider, overrides);
    return { success: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Provider connection test failed"
    };
  }
};