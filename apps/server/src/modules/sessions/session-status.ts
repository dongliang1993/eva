import type { SessionStatus } from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import { DrizzleRunRepository } from "../runs/index.js";
import type { ApprovalGateway } from "../approvals/index.js";

export interface SessionStatusFacts {
  readonly hasPendingApproval: boolean;
  readonly hasRunningRun: boolean;
}

export interface PendingApprovalView {
  readonly callId: string;
  readonly toolName: string;
  readonly args: unknown;
}

export interface SessionRuntimeStatus {
  readonly status: SessionStatus;
  readonly activeRunId: string | null;
  readonly pendingApprovals: readonly PendingApprovalView[];
}

/**
 * 会话状态是**算出来的**,不是存的(docs 14 §5.2 原则 8)。
 * 优先级取首个命中:等人 > 在跑 > 空闲。
 *
 * 子代理是同一 Run 内的 awaited tool,不产生独立 `waiting` 状态。
 */
export const deriveSessionStatus = (facts: SessionStatusFacts): SessionStatus =>
  facts.hasPendingApproval ? "requires_action"
    : facts.hasRunningRun ? "running"
      : "idle";

/** 查事实 → 派生状态。事实来源:runs 表(持久)+ 审批网关(进程内存)。 */
export const readSessionRuntimeStatus = (
  db: AppDatabase,
  approvals: ApprovalGateway,
  sessionId: string
): SessionRuntimeStatus => {
  const activeRun = new DrizzleRunRepository(db).findRunningBySessionId(sessionId);
  const pending = approvals.listPending(sessionId);

  return {
    status: deriveSessionStatus({
      hasPendingApproval: pending.length > 0,
      hasRunningRun: activeRun !== undefined
    }),
    activeRunId: activeRun?.id ?? null,
    pendingApprovals: pending.map((p) => ({
      callId: p.callId,
      toolName: p.tool,
      args: p.args
    }))
  };
};
