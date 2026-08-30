import { buildPolicyKeys } from "@eva/harness";
import type { PlanReviewDecision } from "@eva/shared";

import type { ApprovalGateway, PendingApprovalView } from "../services/approval-gateway.js";
import type { ApprovalPolicyStore } from "../services/approval-policy-store.js";

export interface ApprovalsApi {
  listPending(sessionId?: string): readonly PendingApprovalView[];
  /** 提交普通工具决策。false = 没有这条 pending(调用方回 404)。 */
  decide(callId: string, allowed: boolean): boolean;
  /** T45b:plan review 的结构化决策。false = 没有这条 pending。 */
  decidePlanReview(callId: string, decision: Omit<PlanReviewDecision, "decidedAt">): boolean;
  /**
   * T31「始终允许」:从 {tool, sessionId, args} 算出 policy key 并记住它。
   *
   * key 由 harness 的 buildPolicyKeys 生成 —— **前端不拼 key**,否则就有第二个事实源。
   * 返回 null = 这个工具不可记忆(destructive 双保险 / 只读或未知工具),不落库。
   */
  grantPolicy(input: {
    readonly tool: string;
    readonly sessionId: string;
    readonly args: Record<string, unknown>;
  }): string | null;
}

export const createApprovalsApi = (deps: {
  readonly approvals: ApprovalGateway;
  readonly policies: ApprovalPolicyStore;
}): ApprovalsApi => ({
  listPending: (sessionId) => deps.approvals.listPending(sessionId),
  decide: (callId, allowed) => deps.approvals.decide(callId, allowed),
  decidePlanReview: (callId, decision) => deps.approvals.decidePlanReview(callId, decision),

  grantPolicy: ({ tool, sessionId, args }) => {
    const keys = buildPolicyKeys({ toolName: tool, threadId: sessionId, args });

    if (keys.length === 0) {
      return null;
    }

    // 精确 key 在前(T27 保证):点「始终允许 npm test」只记这一条命令,不是 :all 粗放。
    const key = keys[0]!;
    deps.policies.grant(key);

    return key;
  }
});
