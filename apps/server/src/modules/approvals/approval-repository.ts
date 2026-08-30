import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "../../db/index.js";
import { approvalRequests } from "../../db/schema.js";

export type ApprovalStatus =
  | "pending"
  | "granted"
  | "denied"
  | "revise"
  | "reject_and_exit"
  | "dismissed";

export type ApprovalKind = "tool" | "plan_review";

export interface ApprovalRequestRow {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly tool: string;
  readonly kind: ApprovalKind;
  readonly args: string; // JSON stringified
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  /** T28:决策来源(policy:<key>/stale-restart/...),NULL = 用户手批。 */
  readonly reason: string | null;
  /** T45b:kind='plan_review' 时的 PlanReviewDecision JSON。 */
  readonly decision: string | null;
}

export interface CreateApprovalInput {
  readonly id: string; // tool callId
  readonly sessionId: string;
  readonly runId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly kind?: ApprovalKind;
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
        kind: input.kind ?? "tool",
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
      kind: row.kind,
      args: row.args,
      status: row.status as ApprovalStatus,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      reason: row.reason,
      decision: row.decision
    };
  }

  /**
   * 进程启动清扫遗留 pending。按 kind 分流(契约 6):
   * - tool → denied(用户点 Stop/重启,对这些工具确实算拒绝);
   * - plan_review → dismissed(没有人拒绝过,不能伪造用户决策)。
   * @returns 被收尾的数量
   */
  failStalePending(): number {
    const decidedAt = new Date().toISOString();

    const tools = this.db
      .update(approvalRequests)
      .set({ status: "denied", decidedAt, reason: "stale-restart" })
      .where(and(eq(approvalRequests.status, "pending"), eq(approvalRequests.kind, "tool")))
      .run();

    const planReviews = this.db
      .update(approvalRequests)
      .set({ status: "dismissed", decidedAt, reason: "stale-restart" })
      .where(and(eq(approvalRequests.status, "pending"), eq(approvalRequests.kind, "plan_review")))
      .run();

    return tools.changes + planReviews.changes;
  }

  decide(
    id: string,
    status: Extract<ApprovalStatus, "granted" | "denied" | "revise" | "reject_and_exit" | "dismissed">,
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

  /** T45b:plan review 决策 —— status 映射 + PlanReviewDecision JSON 一起落。 */
  decidePlanReview(
    id: string,
    status: Extract<ApprovalStatus, "granted" | "denied" | "revise" | "reject_and_exit" | "dismissed">,
    decisionJson: string
  ): void {
    this.db
      .update(approvalRequests)
      .set({
        status,
        decision: decisionJson,
        decidedAt: new Date().toISOString()
      })
      .where(eq(approvalRequests.id, id))
      .run();
  }
}
