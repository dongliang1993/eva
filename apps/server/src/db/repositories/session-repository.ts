import { eq, desc } from "drizzle-orm";

import type { AppDatabase } from "../index.js";
import { sessions } from "../schema.js";
import type { Session, CreateSessionInput, ISessionRepository } from "./types.js";

export class DrizzleSessionRepository implements ISessionRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateSessionInput): Session {
    const values = {
      id: input.id,
      sessionKey: input.sessionKey,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {})
    };

    this.db.insert(sessions).values(values).run();

    return this.findById(input.id)!;
  }

  findById(id: string): Session | undefined {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
  }

  listAll(limit = 50): readonly Session[] {
    return this.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.updatedAt))
      .limit(limit)
      .all();
  }

  findBySessionKey(sessionKey: string): Session | undefined {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.sessionKey, sessionKey))
      .orderBy(desc(sessions.updatedAt))
      .limit(1)
      .get();
  }

  updateTimestamp(id: string): void {
    this.db
      .update(sessions)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(sessions.id, id))
      .run();
  }

  updateTitle(id: string, title: string): void {
    this.db
      .update(sessions)
      .set({ title })
      .where(eq(sessions.id, id))
      .run();
  }

  updateModel(id: string, model: string): void {
    this.db
      .update(sessions)
      .set({ model })
      .where(eq(sessions.id, id))
      .run();
  }

  deleteById(id: string): boolean {
    const result = this.db
      .delete(sessions)
      .where(eq(sessions.id, id))
      .run();

    return result.changes > 0;
  }
}
