import { eq, sql } from "drizzle-orm";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import { isVecAvailable } from "../../db/index.js";
import { MemoryEmbeddingRepository } from "../../db/repositories/memory-embedding-repository.js";
import { memories } from "../../db/schema.js";
import { resolveModelSlot } from "../providers/model-resolver.js";

export interface EmbeddingResult {
  readonly embedding: Float32Array;
  readonly model: string;
  readonly dimensions: number;
}

/**
 * embedding 走 providers 表 + settings.models.embedding 槽位。
 * 槽位不可用 → 返回 undefined(语义检索降级为纯 FTS,不是崩溃)。
 */
const resolveEmbeddingBinding = (db: AppDatabase, config: AppConfig) => {
  const resolved = resolveModelSlot(db, config, "embedding");

  if (!resolved.ok) {
    return { ok: false as const, reason: resolved.reason };
  }

  return { ok: true as const, binding: resolved.binding };
};

/**
 * Generate an embedding vector for the given text via the provider's
 * OpenAI-compatible /embeddings API.
 */
export const generateEmbedding = async (
  provider: { readonly modelId: string; readonly apiKey: string; readonly baseURL?: string; readonly qualifiedModelId: string },
  text: string
): Promise<EmbeddingResult> => {
  const baseURL = (provider.baseURL ?? "").replace(/\/+$/, "");
  const response = await fetch(`${baseURL}/embeddings`, {
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
    model: provider.qualifiedModelId,
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

  const resolved = resolveEmbeddingBinding(db, config);
  if (!resolved.ok) return false;
  const provider = resolved.binding;

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

  const resolved = resolveEmbeddingBinding(db, config);
  if (!resolved.ok) return { processed: 0, remaining: 0 };

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
