import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "../index.js";
import { plans, type PlanStatus } from "../schema.js";

export type PlanRow = typeof plans.$inferSelect;

export class DrizzlePlanRepository {
  constructor(private readonly db: AppDatabase) {}

  findById(id: string): PlanRow | undefined {
    return this.db.select().from(plans).where(eq(plans.id, id)).get();
  }

  findActive(sessionId: string): PlanRow | undefined {
    return this.db
      .select()
      .from(plans)
      .where(and(eq(plans.sessionId, sessionId), eq(plans.status, "active")))
      .get();
  }

  create(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly path: string;
  }): PlanRow {
    this.db
      .insert(plans)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        path: input.path,
      })
      .run();

    return this.findById(input.id)!;
  }

  bumpRevision(id: string): PlanRow | undefined {
    const current = this.findById(id);
    if (!current) return undefined;

    this.db
      .update(plans)
      .set({
        revisionCount: current.revisionCount + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(plans.id, id))
      .run();

    return this.findById(id);
  }

  setStatus(id: string, status: PlanStatus): PlanRow | undefined {
    this.db
      .update(plans)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(plans.id, id))
      .run();

    return this.findById(id);
  }
}
