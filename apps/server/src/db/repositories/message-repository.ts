import { asc, eq, sql } from "drizzle-orm";

import type { AppDatabase } from "../index.js";
import { messages } from "../schema.js";
import type {
  Message,
  CreateMessageInput,
  GetMessagesOptions,
  IMessageRepository
} from "./types.js";

const DEFAULT_LIMIT = 100;

export class DrizzleMessageRepository implements IMessageRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateMessageInput): Message {
    const values = {
      id: input.id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      ...(input.searchText !== undefined ? { searchText: input.searchText } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.tokenUsage !== undefined ? { tokenUsage: input.tokenUsage } : {})
    };

    this.db.insert(messages).values(values).run();

    return this.db
      .select()
      .from(messages)
      .where(eq(messages.id, input.id))
      .get()!;
  }

  findBySessionId(
    sessionId: string,
    options: GetMessagesOptions = {}
  ): readonly Message[] {
    const limit = options.limit ?? DEFAULT_LIMIT;

    return this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt), sql`rowid`)
      .limit(limit)
      .all();
  }

  deleteBySessionId(sessionId: string): number {
    const result = this.db
      .delete(messages)
      .where(eq(messages.sessionId, sessionId))
      .run();

    return result.changes;
  }
}
