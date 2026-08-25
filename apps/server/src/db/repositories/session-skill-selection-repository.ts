import { eq } from "drizzle-orm";

import type { AppDatabase } from "../index.js";
import { sessionSkillSelections } from "../schema.js";

export type SessionSkillSelectionOrigin = "auto" | "forced";

export interface SessionSkillSelectionRow {
  readonly sessionId: string;
  readonly skillName: string;
  readonly origin: SessionSkillSelectionOrigin;
  readonly createdAt: string;
}

export class DrizzleSessionSkillSelectionRepository {
  constructor(private readonly db: AppDatabase) {}

  listBySession(sessionId: string): readonly SessionSkillSelectionRow[] {
    return this.db
      .select()
      .from(sessionSkillSelections)
      .where(eq(sessionSkillSelections.sessionId, sessionId))
      .orderBy(sessionSkillSelections.createdAt)
      .all();
  }

  upsertMany(
    sessionId: string,
    skillNames: readonly string[],
    origin: SessionSkillSelectionOrigin = "auto",
  ): void {
    for (const skillName of new Set(skillNames)) {
      this.db
        .insert(sessionSkillSelections)
        .values({ sessionId, skillName, origin })
        .onConflictDoNothing()
        .run();
    }
  }

  deleteBySession(sessionId: string): number {
    return this.db
      .delete(sessionSkillSelections)
      .where(eq(sessionSkillSelections.sessionId, sessionId))
      .run().changes;
  }
}
