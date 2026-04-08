import { eq, sql } from "drizzle-orm";

import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import { isVecAvailable } from "../db/index.js";
import { MemoryEmbeddingRepository } from "../db/repositories/memory-embedding-repository.js";
import { memories } from "../db/schema.js";
import { loadAppSettings } from "./settings-store.js";

export interface EmbeddingResult {
  readonly embedding: Float32Array;
  readonly model: string;
  readonly dimensions: number;
}

interface ResolvedEmbeddingProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly baseUrl: string;
}

const resolveEmbeddingProvider = (
  db: AppDatabase,
  config: AppConfig
): ResolvedEmbeddingProvider | undefined => {
  const settings = loadAppSettings(db, config);
  const { baseUrl, apiKey, model } = settings.memory.embedding;

  if (!baseUrl || !apiKey || !model) return undefined;

  return {
    providerId: "embedding",
    modelId: model,
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, "")
  };
};

/**
 * Generate an embedding vector for the given text via the provider's
 * OpenAI-compatible /embeddings API.
 */
export const generateEmbedding = async (
  provider: ResolvedEmbeddingProvider,
  text: string
): Promise<EmbeddingResult> => {
  const response = await fetch(`${provider.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: provider.modelId,
      input: text
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Embedding API error ${response.status}: ${body.slice(0, 200)}`
    );
  }

  const json = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  const vec = json.data[0]?.embedding;

  if (!vec || vec.length === 0) {
    throw new Error("Embedding API returned empty vector");
  }

  return {
    embedding: new Float32Array(vec),
    model: `${provider.providerId}:${provider.modelId}`,
    dimensions: vec.length
  };
};

/**
 * Embed a single memory and store the vector.
 * Updates embedding_status, embedding_model, embedded_at on the memories row.
 */
export const embedAndStoreMemory = async (
  db: AppDatabase,
  config: AppConfig,
  memoryId: string,
  content: string
): Promise<boolean> => {
  if (!isVecAvailable()) return false;

  const provider = resolveEmbeddingProvider(db, config);
  if (!provider) return false;

  try {
    const result = await generateEmbedding(provider, content);

    const vecRepo = new MemoryEmbeddingRepository(db);
    vecRepo.upsert(memoryId, result.embedding);

    db.update(memories)
      .set({
        embeddingStatus: "ready",
        embeddingModel: result.model,
        embeddedAt: new Date().toISOString()
      })
      .where(eq(memories.id, memoryId))
      .run();

    return true;
  } catch (err) {
    console.error("[memory-embedding] embedAndStoreMemory failed:", err);
    db.update(memories)
      .set({ embeddingStatus: "error" })
      .where(eq(memories.id, memoryId))
      .run();

    return false;
  }
};

/**
 * Batch-embed pending memories. Returns the number processed.
 */
export const backfillPendingEmbeddings = async (
  db: AppDatabase,
  config: AppConfig,
  limit = 50
): Promise<{ processed: number; remaining: number }> => {
  if (!isVecAvailable()) return { processed: 0, remaining: 0 };

  const provider = resolveEmbeddingProvider(db, config);
  if (!provider) return { processed: 0, remaining: 0 };

  const pending = db
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(
      sql`${memories.embeddingStatus} IN ('pending', 'error')`
    )
    .limit(limit)
    .all();

  let processed = 0;

  for (const row of pending) {
    const ok = await embedAndStoreMemory(db, config, row.id, row.content);
    if (ok) processed++;
  }

  const remainingCount = db
    .select({ id: memories.id })
    .from(memories)
    .where(sql`${memories.embeddingStatus} IN ('pending', 'error')`)
    .all().length;

  return { processed, remaining: remainingCount };
};
