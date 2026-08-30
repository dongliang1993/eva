import type { FastifyInstance } from "fastify";
import { z } from "zod";

interface GrantBody {
  readonly tool: string;
  readonly sessionId: string;
  readonly args: Record<string, unknown>;
}

const grantBodySchema = z.object({
  tool: z.string().min(1),
  sessionId: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({})
});

/**
 * T31:「始终允许」写入口(docs/plans/r7/T31 §2.1)。
 *
 * policy key 生成必须在后端(buildPolicyKeys 是 harness 纯函数,单一事实来源)——
 * 前端只传 {tool, sessionId, args},由这里选精确 key(keys[0],T27 顺序保证)再 grant。
 * 前端不拼 key,就不会有第二个事实源。
 */
export const registerApprovalPolicyRoutes = (app: FastifyInstance): void => {
  app.post<{ Body: GrantBody }>("/api/v1/approval-policies/grant", async (request, reply) => {
    const parsed = grantBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "tool / sessionId 必填" };
    }

    const { tool, sessionId, args } = parsed.data;
    // key 生成与记忆都在 api 层 —— 不可记忆的工具返回 null,前端别弹「已加入」。
    const key = app.api.approvals.grantPolicy({ tool, sessionId, args });

    if (key !== null) {
      request.log.info({ key, tool, sessionId }, "approval policy granted");
    }

    return { key };
  });
};
