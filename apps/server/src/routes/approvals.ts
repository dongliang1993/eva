import type { FastifyInstance } from "fastify";

interface DecideBody {
  readonly allowed: boolean;
}

/**
 * 危险工具审批决策接口。
 * - GET  /api/v1/tool-approvals         列出全部待审批
 * - POST /api/v1/tool-approvals/:callId  提交决策 granted/denied
 * 前端在 SSE 的 approval_request 事件后, 用户点按钮 → POST 这里。
 */
export const registerApprovalRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/tool-approvals", async () => {
    const pending = app.services.approvals.listPending();
    return {
      approvals: pending.map((p) => ({ callId: p.callId, tool: p.tool, args: p.args }))
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
};