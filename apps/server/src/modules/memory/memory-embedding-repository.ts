import type Database from "better-sqlite3";

import type { AppDatabase } from "../../db/index.js";

export interface VecSearchResult {
  readonly memoryId: string;
  readonly distance: number;
}

/**
 * Raw SQL repository for the `memory_embeddings` vec0 virtual table.
 * Drizzle ORM does not support vec0 virtual tables, so we use the
 * underlying better-sqlite3 driver directly.
 */
export class MemoryEmbeddingRepository {
  private readonly sqlite: Database.Database;

  constructor(db: AppDatabase) {
    this.sqlite = (db as unknown as { $client: Database.Database }).$client;
  }

  upsert(memoryId: string, embedding: Float32Array): void {
    this.sqlite
      .prepare(
        "INSERT OR REPLACE INTO memory_embeddings(memory_id, embedding) VALUES (?, ?)"
      )
      .run(memoryId, Buffer.from(embedding.buffer));
  }

  search(
    queryEmbedding: Float32Array,
    topK: number,
    threshold: number
  ): readonly VecSearchResult[] {
    const rows = this.sqlite
      .prepare(
        `SELECT memory_id AS memoryId, distance
         FROM memory_embeddings
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(Buffer.from(queryEmbedding.buffer), topK) as Array<{
      memoryId: string;
      distance: number;
    }>;

    // Filter by distance threshold (lower = more similar for cosine distance)
    return rows.filter((r) => r.distance <= threshold);
  }

  delete(memoryId: string): void {
    this.sqlite
      .prepare("DELETE FROM memory_embeddings WHERE memory_id = ?")
      .run(memoryId);
  }

  /** 直接按 memory_id 查,确认向量存在(不依赖距离检索)。 */
  has(memoryId: string): boolean {
    const row = this.sqlite
      .prepare("SELECT 1 AS present FROM memory_embeddings WHERE memory_id = ?")
      .get(memoryId) as { present: number } | undefined;

    return row !== undefined;
  }

  countByStatus(): { ready: number; pending: number } {
    // Count via main memories table since vec0 doesn't support aggregation well
    const ready = this.sqlite
      .prepare("SELECT count(*) AS c FROM memory_embeddings")
      .get() as { c: number } | undefined;

    return {
      ready: ready?.c ?? 0,
      pending: 0 // caller should compute from memories table
    };
  }
}
