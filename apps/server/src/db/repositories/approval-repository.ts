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
  /** T28:决策来源(policy:<key>/stale-restart/...),NULL = 用户手批。 */
  readonly reason: string | null;
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
      decidedAt: row.decidedAt,
      reason: row.reason
    };
  }

  /**
   * 进程启动时把上次遗留的 pending 审批收成 denied。
   *
   * 审批不再超时(出口只有人工决策 / cancelByRun / 进程重启)之后,这一步是
   * 必需的:待决表在内存 Map 里,随进程消失;DB 里的 pending 行没人收就永远挂着,
   * 和 runs 表当初的问题一模一样(见 DrizzleRunRepository.failStale)。
   * @returns 被收尾的数量
   */
  failStalePending(): number {
    const result = this.db
      .update(approvalRequests)
      .set({ status: "denied", decidedAt: new Date().toISOString(), reason: "stale-restart" })
      .where(eq(approvalRequests.status, "pending"))
      .run();

    return result.changes;
  }

  decide(
    id: string,
    status: Extract<ApprovalStatus, "granted" | "denied">,
    reason?: string
  ): void {
    this.db
      .update(approvalRequests)
      .set({
        status,
        decidedAt: new Date().toISOString(),
        // T28:reason 是决策时的产物(policy:/stale-restart/readonly-safe),不传不动该列。
        ...(reason !== undefined ? { reason } : {})
      })
      .where(eq(approvalRequests.id, id))
      .run();
  }
}