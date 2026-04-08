import { eq } from "drizzle-orm";
import type { ProviderModel } from "@eva/shared";

import type { AppDatabase } from "../db/index.js";
import { providerModelsCache } from "../db/schema.js";
import { findStoredProviderById } from "./settings-store.js";

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.cn/v1"
};

/** Max cache age before considered stale (1 hour). */
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Get cached models for a provider, or undefined if stale/missing.
 */
export const getCachedModels = (
  db: AppDatabase,
  providerId: string,
  maxAgeMs = CACHE_MAX_AGE_MS
): readonly ProviderModel[] | undefined => {
  const row = db
    .select()
    .from(providerModelsCache)
    .where(eq(providerModelsCache.providerId, providerId))
    .get();

  if (!row) return undefined;

  const age = Date.now() - new Date(row.fetchedAt).getTime();
  if (age > maxAgeMs) return undefined;

  try {
    return JSON.parse(row.models) as ProviderModel[];
  } catch {
    return undefined;
  }
};

/**
 * Fetch models from provider's /models API and store in cache.
 */
export const fetchAndCacheProviderModels = async (
  db: AppDatabase,
  providerId: string
): Promise<readonly ProviderModel[]> => {
  const provider = findStoredProviderById(db, providerId);

  if (!provider || !provider.enabled || !provider.apiKey) {
    throw new Error(`Provider "${providerId}" is not configured or not enabled.`);
  }

  const baseUrl = provider.baseURL?.replace(/\/+$/, "")
    || DEFAULT_BASE_URLS[provider.type]
    || "";

  if (!baseUrl) {
    throw new Error(`No base URL for provider "${providerId}".`);
  }

  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models from ${providerId}: ${response.status}`);
  }

  const json = (await response.json()) as {
    data?: Array<{ id: string; owned_by?: string }>;
  };

  const models: ProviderModel[] = (json.data ?? []).map((m) => ({
    id: m.id,
    name: m.id
  }));

  // Upsert cache
  const now = new Date().toISOString();
  const existing = db
    .select()
    .from(providerModelsCache)
    .where(eq(providerModelsCache.providerId, providerId))
    .get();

  if (existing) {
    db.update(providerModelsCache)
      .set({
        models: JSON.stringify(models),
        fetchedAt: now,
        updatedAt: now
      })
      .where(eq(providerModelsCache.id, existing.id))
      .run();
  } else {
    db.insert(providerModelsCache)
      .values({
        id: crypto.randomUUID(),
        providerId,
        models: JSON.stringify(models),
        fetchedAt: now
      })
      .run();
  }

  return models;
};

/**
 * Get models for a provider — cache first, fetch if stale or missing.
 */
export const getProviderModels = async (
  db: AppDatabase,
  providerId: string
): Promise<readonly ProviderModel[]> => {
  const cached = getCachedModels(db, providerId);
  if (cached) return cached;

  return fetchAndCacheProviderModels(db, providerId);
};
