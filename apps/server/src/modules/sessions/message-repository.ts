import { asc, desc, eq, sql } from "drizzle-orm";
import { parseUIMessage, uiMessageSearchText } from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import { messages } from "../../db/schema.js";
import type {
  CreateMessageInput,
  GetMessagesOptions,
  IMessageRepository,
  StoredMessage
} from "../../db/repositories/types.js";

const DEFAULT_LIMIT = 100;

const toStored = (row: typeof messages.$inferSelect): StoredMessage => ({
  id: row.id,
  sessionId: row.sessionId,
  runId: row.runId,
  role: row.role,
  message: parseUIMessage(row.message, { id: row.id, role: row.role }),
  parentId: row.parentId,
  slotId: row.slotId,
  depth: row.depth,
  parentToolCallId: row.parentToolCallId,
  createdAt: row.createdAt
});

export class DrizzleMessageRepository implements IMessageRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateMessageInput): StoredMessage {
    const { message } = input;

    if (message.role !== "user" && message.role !== "assistant") {
      // system 消息不落库:compaction 摘要是运行时拼进 ModelMessage 的。
      throw new Error(`Cannot persist message with role "${message.role}"`);
    }

    this.db
      .insert(messages)
      .values({
        id: message.id,
        sessionId: input.sessionId,
        role: message.role,
        message: JSON.stringify(message),
        searchText: uiMessageSearchText(message),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.slotId !== undefined ? { slotId: input.slotId } : {}),
        ...(input.depth !== undefined ? { depth: input.depth } : {}),
        ...(input.parentToolCallId !== undefined ? { parentToolCallId: input.parentToolCallId } : {})
      })
      .run();

    return toStored(
      this.db.select().from(messages).where(eq(messages.id, message.id)).get()!
    );
  }

  findBySessionId(
    sessionId: string,
    options: GetMessagesOptions = {}
  ): readonly StoredMessage[] {
    const limit = options.limit ?? DEFAULT_LIMIT;

    return this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt), sql`rowid`)
      .limit(limit)
      .all()
      .map(toStored);
  }

  findLastBySessionId(sessionId: string): StoredMessage | undefined {
    const row = this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt), sql`rowid DESC`)
      .limit(1)
      .get();

    return row ? toStored(row) : undefined;
  }

  findById(id: string): StoredMessage | undefined {
    const row = this.db
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .get();

    return row ? toStored(row) : undefined;
  }

  findBySubagentToolCallId(parentToolCallId: string): readonly StoredMessage[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.parentToolCallId, parentToolCallId))
      .orderBy(asc(messages.createdAt), sql`rowid`)
      .all()
      .map(toStored);
  }

  deleteBySessionId(sessionId: string): number {
    const result = this.db
      .delete(messages)
      .where(eq(messages.sessionId, sessionId))
      .run();

    return result.changes;
  }
}
