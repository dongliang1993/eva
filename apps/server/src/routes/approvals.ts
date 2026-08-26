import type { FastifyInstance } from "fastify";

import { planReviewOutcomes, type PlanReviewOutcome } from "@eva/shared";

interface DecideBody {
  readonly allowed: boolean;
}

interface PlanReviewBody {
  readonly outcome: PlanReviewOutcome;
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

const CLIENT_SUBMITTABLE_OUTCOMES = new Set<PlanReviewOutcome>(
  planReviewOutcomes.filter((outcome) => outcome !== "dismissed")
);

/**
 * 危险工具审批决策接口。
 * - GET  /api/v1/tool-approvals                         列出全部待审批(普通工具)
 * - POST /api/v1/tool-approvals/:callId                 提交普通工具决策 granted/denied
 * - POST /api/v1/tool-approvals/:callId/plan-review     提交 plan review 结构化决策
 */
export const registerApprovalRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/tool-approvals", async (request) => {
    const { sessionId } = request.query as { sessionId?: string };
    const pending = app.services.approvals.listPending(sessionId);
    return {
      approvals: pending.map((p) => ({
        callId: p.callId,
        runId: p.runId,
        tool: p.tool,
        args: p.args,
        risk: p.risk
      }))
    };
  });

  app.post<{ Params: { callId: string }; Body: Partial<DecideBody> }>(
    "/api/v1/tool-approvals/:callId",
    async (request, reply) => {
      const callId = request.params.callId;
      const allowed = request.body?.allowed ?? false;
      const decided = app.services.approvals.decide(callId, allowed);

      if (!decided) {
        reply.code(404);
        return { error: `No pending approval for callId "${callId}".` };
      }

      return { ok: true, callId, allowed };
    }
  );

  // T45b:plan review 平行通道。dismissed 只能由系统(cancelByRun/重启清扫)产生,不接受前端提交。
  app.post<{ Params: { callId: string }; Body: Partial<PlanReviewBody> }>(
    "/api/v1/tool-approvals/:callId/plan-review",
    async (request, reply) => {
      const callId = request.params.callId;
      const outcome = request.body?.outcome;

      if (!outcome || !CLIENT_SUBMITTABLE_OUTCOMES.has(outcome)) {
        reply.code(400);
        return { error: `Invalid plan review outcome: ${String(outcome)}` };
      }

      const feedback = request.body?.feedback;
      if (outcome === "revise" && !(feedback ?? "").trim()) {
        reply.code(400);
        return { error: "revise requires non-empty feedback." };
      }

      const decided = app.services.approvals.decidePlanReview(callId, {
        outcome,
        ...(feedback !== undefined ? { feedback } : {}),
        ...(request.body?.selectedLabel !== undefined
          ? { selectedLabel: request.body.selectedLabel }
          : {})
      });

      if (!decided) {
        reply.code(404);
        return { error: `No pending plan review for callId "${callId}".` };
      }

      return { ok: true, callId, outcome };
    }
  );
};
