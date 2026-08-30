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
 * docs 14 还列了第四态 `waiting`(主 loop 闲但有存活后台任务)。后台任务是 S7
 * 的概念,现在不存在 —— 不为不存在的概念留字段,S7 引入 background_tasks 时再加。
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
