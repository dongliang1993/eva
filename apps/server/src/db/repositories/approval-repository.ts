import { eq } from "drizzle-orm";

import type { AppDatabase } from "../index.js";
import { approvalRequests } from "../schema.js";

export type ApprovalStatus = "pending" | "granted" | "denied";

export interface ApprovalRequestRow {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly tool: string;
  readonly args: string; // JSON stringified
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface CreateApprovalInput {
  readonly id: string; // tool callId
  readonly sessionId: string;
  readonly runId: string;
  readonly tool: string;
  readonly args: unknown;
}

export class ApprovalRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateApprovalInput): ApprovalRequestRow {
    this.db
      .insert(approvalRequests)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        runId: input.runId,
        tool: input.tool,
        args: JSON.stringify(input.args)
      })
      .run();

    return this.getById(input.id)!;
  }

  getById(id: string): ApprovalRequestRow | undefined {
    const row = this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .get();

    if (!row) return undefined;

    return {
      id: row.id,
      sessionId: row.sessionId,
      runId: row.runId,
      tool: row.tool,
      args: row.args,
      status: row.status as ApprovalStatus,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt
    };
  }

  decide(id: string, status: Extract<ApprovalStatus, "granted" | "denied">): void {
    this.db
      .update(approvalRequests)
      .set({
        status,
        decidedAt: new Date().toISOString()
      })
      .where(eq(approvalRequests.id, id))
      .run();
  }
}