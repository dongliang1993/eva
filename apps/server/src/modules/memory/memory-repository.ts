import { and, eq, like, desc } from "drizzle-orm";

import type { AppDatabase } from "../../db/index.js";
import { memories, type MemoryCategory, type MemoryOrigin } from "../../db/schema.js";

export interface Memory {
  readonly id: string;
  readonly category: MemoryCategory;
  readonly origin: MemoryOrigin;
  readonly content: string;
  readonly metadata: string;
  readonly sourceSessionId: string | null;
  readonly sourceMessageId: string | null;
  readonly userId: string;
  readonly embeddingStatus: string;
  readonly embeddingModel: string | null;
  readonly embeddedAt: string | null;
  readonly lastRecalledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMemoryInput {
  readonly id: string;
  readonly content: string;
  readonly category?: MemoryCategory;
  readonly origin?: MemoryOrigin;
  readonly metadata?: string;
  readonly sourceSessionId?: string;
  readonly sourceMessageId?: string;
  readonly userId?: string;
}

export interface IMemoryRepository {
  save(input: CreateMemoryInput): Memory;
  search(query: string, userId?: string, limit?: number): readonly Memory[];
  listAll(userId?: string, limit?: number): readonly Memory[];
  findById(id: string): Memory | undefined;
  update(id: string, content: string, category?: MemoryCategory): Memory | undefined;
  deleteById(id: string): boolean;
}

export class DrizzleMemoryRepository implements IMemoryRepository {
  constructor(private readonly db: AppDatabase) {}

  save(input: CreateMemoryInput): Memory {
    const values: typeof memories.$inferInsert = {
      id: input.id,
      content: input.content
    };

    if (input.category !== undefined) values.category = input.category;
    if (input.origin !== undefined) values.origin = input.origin;
    if (input.metadata !== undefined) values.metadata = input.metadata;
    if (input.sourceSessionId !== undefined) values.sourceSessionId = input.sourceSessionId;
    if (input.sourceMessageId !== undefined) values.sourceMessageId = input.sourceMessageId;
    if (input.userId !== undefined) values.userId = input.userId;

    this.db.insert(memories).values(values).run();

    return this.findById(input.id)!;
  }

  search(query: string, userId = "default", limit = 10): readonly Memory[] {
    return this.db
      .select()
      .from(memories)
      .where(and(eq(memories.userId, userId), like(memories.content, `%${query}%`)))
      .orderBy(desc(memories.updatedAt))
      .limit(limit)
      .all();
  }

  listAll(userId = "default", limit = 100): readonly Memory[] {
    return this.db
      .select()
      .from(memories)
      .where(eq(memories.userId, userId))
      .orderBy(desc(memories.updatedAt))
      .limit(limit)
      .all();
  }

  findById(id: string): Memory | undefined {
    return this.db
      .select()
      .from(memories)
      .where(eq(memories.id, id))
      .get();
  }

  update(id: string, content: string, category?: MemoryCategory): Memory | undefined {
    const set: Partial<typeof memories.$inferInsert> = {
      content,
      updatedAt: new Date().toISOString()
    };

    if (category !== undefined) set.category = category;

    this.db
      .update(memories)
      .set(set)
      .where(eq(memories.id, id))
      .run();

    return this.findById(id);
  }

  deleteById(id: string): boolean {
    const result = this.db
      .delete(memories)
      .where(eq(memories.id, id))
      .run();

    return result.changes > 0;
  }
}
