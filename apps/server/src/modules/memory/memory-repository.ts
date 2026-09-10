import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { AppDatabase } from "../../db/index.js";
import {
  memories,
  type MemoryCategory,
  type MemoryOrigin,
  type MemoryStatus
} from "../../db/schema.js";

export interface Memory {
  readonly id: string;
  readonly category: MemoryCategory;
  readonly origin: MemoryOrigin;
  readonly content: string;
  readonly metadata: string;
  readonly scopeKey: string;
  readonly memoryKey: string | null;
  readonly status: MemoryStatus;
  readonly sourceSessionId: string | null;
  readonly sourceMessageId: string | null;
  readonly sourceRunId: string | null;
  readonly confidence: number | null;
  readonly revision: number;
  readonly userId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelevantMemory extends Memory {
  /** SQLite bm25 score: lower is more relevant. */
  readonly score: number;
}

export interface CreateMemoryInput {
  readonly id: string;
  readonly content: string;
  readonly category?: MemoryCategory;
  readonly origin?: MemoryOrigin;
  readonly metadata?: string;
  readonly scopeKey?: string;
  readonly memoryKey?: string;
  readonly status?: MemoryStatus;
  readonly sourceSessionId?: string;
  readonly sourceMessageId?: string;
  readonly sourceRunId?: string;
  readonly confidence?: number;
  readonly userId?: string;
}

export interface UpsertExtractedMemoryInput {
  readonly id: string;
  readonly targetMemoryId?: string | undefined;
  readonly targetRevision?: number | undefined;
  readonly content: string;
  readonly category: MemoryCategory;
  readonly scopeKey: string;
  readonly memoryKey: string;
  readonly sourceSessionId: string;
  readonly sourceMessageId: string;
  readonly sourceRunId: string;
  readonly confidence: number;
  readonly userId?: string;
}

export interface IMemoryRepository {
  save(input: CreateMemoryInput): Memory;
  search(query: string, userId?: string, limit?: number): readonly Memory[];
  searchRelevant(query: string, scopeKeys: readonly string[], userId?: string, limit?: number): readonly RelevantMemory[];
  listAll(userId?: string, limit?: number): readonly Memory[];
  listActiveInScopes(scopeKeys: readonly string[], userId?: string, limit?: number): readonly Memory[];
  findById(id: string): Memory | undefined;
  upsertExtracted(input: UpsertExtractedMemoryInput): Memory;
  update(id: string, content: string, category?: MemoryCategory): Memory | undefined;
  deleteById(id: string): boolean;
}

const STOP_WORDS = new Set([
  "and", "are", "but", "can", "for", "from", "have", "how", "into", "not",
  "the", "that", "this", "was", "what", "when", "where", "which", "with", "you",
]);

export class MemoryConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("记忆已被修改、删除或已有同名事实；请忽略这个旧候选，以当前记忆为准。");
  }
}

/** Build a bounded, syntax-safe OR query for the trigram FTS index. */
export const toMemoryFtsQuery = (query: string): string | undefined => {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (term: string) => {
    const normalized = term.toLocaleLowerCase().trim();
    if (normalized.length < 3 || STOP_WORDS.has(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    terms.push(normalized);
  };

  for (const token of query.match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? []) {
    if (/^\p{Script=Han}+$/u.test(token) && token.length > 3) {
      for (let index = 0; index <= token.length - 3 && terms.length < 16; index++) {
        add(token.slice(index, index + 3));
      }
    } else {
      add(token);
    }
    if (terms.length >= 16) break;
  }

  return terms.length > 0
    ? terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ")
    : undefined;
};

export class DrizzleMemoryRepository implements IMemoryRepository {
  constructor(private readonly db: AppDatabase) { }

  save(input: CreateMemoryInput): Memory {
    const values: typeof memories.$inferInsert = { id: input.id, content: input.content };
    if (input.category !== undefined) values.category = input.category;
    if (input.origin !== undefined) values.origin = input.origin;
    if (input.metadata !== undefined) values.metadata = input.metadata;
    if (input.scopeKey !== undefined) values.scopeKey = input.scopeKey;
    if (input.memoryKey !== undefined) values.memoryKey = input.memoryKey;
    if (input.status !== undefined) values.status = input.status;
    if (input.sourceSessionId !== undefined) values.sourceSessionId = input.sourceSessionId;
    if (input.sourceMessageId !== undefined) values.sourceMessageId = input.sourceMessageId;
    if (input.sourceRunId !== undefined) values.sourceRunId = input.sourceRunId;
    if (input.confidence !== undefined) values.confidence = input.confidence;
    if (input.userId !== undefined) values.userId = input.userId;
    this.db.insert(memories).values(values).run();
    return this.findById(input.id)!;
  }

  search(query: string, userId = "default", limit = 10): readonly Memory[] {
    return this.searchRelevant(query, this.listScopeKeys(userId), userId, limit);
  }

  searchRelevant(query: string, scopeKeys: readonly string[], userId = "default", limit = 10): readonly RelevantMemory[] {
    const ftsQuery = toMemoryFtsQuery(query);
    if (scopeKeys.length === 0 || limit <= 0) return [];
    if (!ftsQuery) {
      // FTS trigram cannot index two-character terms such as 中文 / 架构 / Go.
      // Keep an exact, scope-filtered substring search for that case only.
      const shortQuery = query.trim();
      if (!/^[\p{L}\p{N}]{2}$/u.test(shortQuery)) return [];
      return this.db.select().from(memories).where(and(
        eq(memories.userId, userId), eq(memories.status, "active"),
        inArray(memories.scopeKey, [...scopeKeys]),
        sql`instr(lower(${memories.content}), lower(${shortQuery})) > 0`
      )).orderBy(desc(memories.updatedAt)).limit(limit).all().map((memory) => ({ ...memory, score: 0 }));
    }
    const scopes = sql.join(scopeKeys.map((scope) => sql`${scope}`), sql`, `);
    const preferredScope = scopeKeys.find((scope) => scope !== "global") ?? "global";

    return this.db.all<RelevantMemory>(sql`
      SELECT m.id, m.category, m.origin, m.content, m.metadata,
        m.scope_key AS scopeKey, m.memory_key AS memoryKey, m.status,
        m.source_session_id AS sourceSessionId, m.source_message_id AS sourceMessageId,
        m.source_run_id AS sourceRunId, m.confidence, m.revision, m.user_id AS userId,
        m.created_at AS createdAt, m.updated_at AS updatedAt,
        bm25(memories_fts) AS score
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.memory_id
      WHERE memories_fts MATCH ${ftsQuery}
        AND memories_fts.user_id = ${userId}
        AND memories_fts.status = 'active'
        AND memories_fts.scope_key IN (${scopes})
      ORDER BY CASE WHEN memories_fts.scope_key = ${preferredScope} THEN 0 ELSE 1 END,
        score, m.updated_at DESC
      LIMIT ${limit}
    `);
  }

  listAll(userId = "default", limit = 100): readonly Memory[] {
    return this.db.select().from(memories).where(and(
      eq(memories.userId, userId), eq(memories.status, "active")
    )).orderBy(desc(memories.updatedAt)).limit(limit).all();
  }

  listActiveInScopes(scopeKeys: readonly string[], userId = "default", limit = 50): readonly Memory[] {
    if (scopeKeys.length === 0) return [];
    return this.db.select().from(memories).where(and(
      eq(memories.userId, userId),
      eq(memories.status, "active"),
      inArray(memories.scopeKey, [...scopeKeys])
    )).orderBy(desc(memories.updatedAt)).limit(limit).all();
  }

  findById(id: string): Memory | undefined {
    return this.db.select().from(memories).where(eq(memories.id, id)).get();
  }

  findByKey(scopeKey: string, memoryKey: string, userId = "default"): Memory | undefined {
    return this.db.select().from(memories).where(and(
      eq(memories.userId, userId), eq(memories.scopeKey, scopeKey),
      eq(memories.memoryKey, memoryKey), eq(memories.status, "active")
    )).get();
  }

  upsertExtracted(input: UpsertExtractedMemoryInput): Memory {
    return this.db.transaction(() => {
      const userId = input.userId ?? "default";
      const keyed = this.findByKey(input.scopeKey, input.memoryKey, userId);
      const existing = input.targetMemoryId ? this.findById(input.targetMemoryId) : undefined;
      // Compare the revision read before extraction. Another session or the user
      // may have edited/deleted this fact while the model or review was pending.
      if (input.targetMemoryId) {
        if (!existing || existing.userId !== userId || existing.scopeKey !== input.scopeKey
          || existing.status !== "active" || existing.revision !== input.targetRevision
          || (keyed && keyed.id !== existing.id)) throw new MemoryConflictError();
      } else if (keyed) {
        throw new MemoryConflictError();
      }
      const values = {
        content: input.content,
        category: input.category,
        origin: "auto_extracted" as const,
        scopeKey: input.scopeKey,
        memoryKey: input.memoryKey,
        sourceSessionId: input.sourceSessionId,
        sourceMessageId: input.sourceMessageId,
        sourceRunId: input.sourceRunId,
        confidence: input.confidence,
        updatedAt: new Date().toISOString()
      };

      if (existing) {
        this.db.update(memories).set({ ...values, revision: existing.revision + 1 })
          .where(eq(memories.id, existing.id)).run();
        return this.findById(existing.id)!;
      }
      return this.save({
        id: input.id,
        userId,
        ...values
      });
    });
  }

  update(id: string, content: string, category?: MemoryCategory): Memory | undefined {
    const set: Partial<typeof memories.$inferInsert> = { content, updatedAt: new Date().toISOString() };
    if (category !== undefined) set.category = category;
    this.db.update(memories).set({ ...set, revision: sql`${memories.revision} + 1` })
      .where(eq(memories.id, id)).run();
    return this.findById(id);
  }

  deleteById(id: string): boolean {
    return this.db.delete(memories).where(eq(memories.id, id)).run().changes > 0;
  }

  private listScopeKeys(userId: string): readonly string[] {
    return this.db.selectDistinct({ scopeKey: memories.scopeKey }).from(memories)
      .where(and(eq(memories.userId, userId), eq(memories.status, "active")))
      .all().map((row) => row.scopeKey);
  }
}
