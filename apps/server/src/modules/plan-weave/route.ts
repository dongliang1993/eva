import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { PlanWeaveError, type PlanWeaveErrorCode } from "./schema.js";

/**
 * T46 §2.5:11 条 REST,挂在 workspace 下而不是接 dir 参数 ——
 * dir 会带来「这个目录是不是那个 workspace」的二义,还会变成可喂任意路径的入口。
 * workspace 解析与 404/409/400 映射集中在 sendError。
 */

const refParam = z.string().min(1);

const claimBodySchema = z.object({
  runId: z.string().min(1)
});

const submitBodySchema = z.object({
  ref: refParam,
  report: z.string().min(1)
});

const reviewBodySchema = z.object({
  ref: refParam,
  verdict: z.enum(["approved", "needs_changes"]),
  notes: z.string().optional()
});

const resolveBodySchema = z.object({
  feedbackId: z.string().min(1),
  resolution: z.string().min(1)
});

const blockedBodySchema = z.object({
  ref: refParam,
  blocked: z.boolean(),
  reason: z.string().optional()
});

const STATUS_BY_CODE: Record<PlanWeaveErrorCode, number> = {
  workspace_not_found: 404,
  no_plan: 404,
  not_found: 404,
  plan_exists: 409,
  invalid: 400,
  bad_request: 400
};

/** PlanWeaveError → HTTP;其余错误(含 ZodError)抛回给 app 级 error handler。 */
const sendError = (reply: FastifyReply, error: unknown): { error: string } => {
  if (error instanceof PlanWeaveError) {
    reply.code(STATUS_BY_CODE[error.code]);
    return { error: error.message };
  }
  throw error;
};

export const registerPlanWeaveRoutes = (app: FastifyInstance): void => {
  const service = () => app.api.plans;

  app.get("/api/v1/workspaces/:id/plan", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await service().get(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/v1/workspaces/:id/plan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ plan: z.unknown() }).parse(request.body ?? {});
    try {
      const snapshot = await service().create(id, body.plan);
      reply.code(201);
      return snapshot;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete("/api/v1/workspaces/:id/plan", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await service().remove(id);
      reply.code(204);
      return null;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/v1/workspaces/:id/plan/block", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { ref } = z.object({ ref: refParam }).parse(request.query ?? {});
    try {
      return await service().getBlock(id, ref);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/v1/workspaces/:id/plan/claim", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = claimBodySchema.parse(request.body ?? {});
    try {
      return await service().claim(id, body.runId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/v1/workspaces/:id/plan/submit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = submitBodySchema.parse(request.body ?? {});
    try {
      return await service().submit(id, body.ref, body.report);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/v1/workspaces/:id/plan/review", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = reviewBodySchema.parse(request.body ?? {});
    try {
      return await service().review(id, body.ref, body.verdict, body.notes);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/v1/workspaces/:id/plan/resolve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = resolveBodySchema.parse(request.body ?? {});
    try {
      return await service().resolve(id, body.feedbackId, body.resolution);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/v1/workspaces/:id/plan/blocked", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = blockedBodySchema.parse(request.body ?? {});
    try {
      return await service().setBlocked(id, body.ref, body.blocked, body.reason);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/v1/workspaces/:id/plan/reset", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await service().reset(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/v1/workspaces/:id/plan/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await service().archive(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
