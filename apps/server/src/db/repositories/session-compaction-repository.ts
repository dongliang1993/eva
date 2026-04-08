import { eq } from "drizzle-orm";

import type { AppDatabase } from "../index.js";
import { sessionCompactions } from "../schema.js";

export interface SessionCompaction {
  readonly id: string;
  readonly sessionId: string;
  readonly summary: string;
  readonly coveredUntilMessageId: string;
  readonly coveredMessageCount: number;
  readonly preservedTailMessageCount: number;
  readonly estimatedTokensBefore: number | null;
  readonly estimatedTokensAfter: number | null;
  readonly trigger: string;
  readonly createdAt: string;
}

export interface CreateSessionCompactionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly summary: string;
  readonly coveredUntilMessageId: string;
  readonly coveredMessageCount: number;
  readonly preservedTailMessageCount: number;
  readonly estimatedTokensBefore?: number;
  readonly estimatedTokensAfter?: number;
  readonly trigger: string;
}

export class SessionCompactionRepository {
  constructor(private readonly db: AppDatabase) {}

  findBySessionId(sessionId: string): SessionCompaction | undefined {
    return this.db
      .select()
      .from(sessionCompactions)
      .where(eq(sessionCompactions.sessionId, sessionId))
      .get();
  }

  /**
   * Upsert: delete existing + insert new.
   * One active compaction per session (enforced by unique index).
   */
  upsert(input: CreateSessionCompactionInput): SessionCompaction {
    this.db
      .delete(sessionCompactions)
      .where(eq(sessionCompactions.sessionId, input.sessionId))
      .run();

    this.db
      .insert(sessionCompactions)
      .values(input)
      .run();

    return this.db
      .select()
      .from(sessionCompactions)
      .where(eq(sessionCompactions.id, input.id))
      .get()!;
  }

  deleteBySessionId(sessionId: string): void {
    this.db
      .delete(sessionCompactions)
      .where(eq(sessionCompactions.sessionId, sessionId))
      .run();
  }
}
