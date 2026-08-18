import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ThreadMessage, ThreadStatus, ThreadSummary, ThreadUsage } from "@eva/shared";

import { DrizzleMessageRepository } from "../db/repositories/message-repository.js";
import { DrizzleRunRepository } from "../db/repositories/run-repository.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { compactSession } from "../services/compact.js";
import { deriveSessionStatus, readSessionRuntimeStatus } from "../services/session-status.js";
import { readSessionUsage } from "../services/session-usage.js";
import { createModelSummarizer } from "../services/summarize-with-model.js";
import { messages } from "../db/schema.js";

const listThreadsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional()
});

const getThreadMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional()
});

const createThreadSchema = z.object({
  title: z.string().min(1).max(200).optional()
});

const setThreadWorkspaceSchema = z.object({
  workspaceId: z.string().nullable()
});

interface ThreadCompactResult {
  success: boolean;
  compacted: boolean;
  trigger: "manual";
  coveredMessageCount: number;
  preservedTailMessageCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  compactionId?: string;
  thread: ThreadSummary;
}

/**
 * 列表一次查完(不要 N+1):running 会话 id 一次查,running 之外再逐条查审批。
 * pending 数量正常是 0–2,会话数上百时 O(threads×pending) 可接受;若成为热点,
 * 再给 ApprovalGateway 加 sessionId → count 索引。
 */
const listThreadSummaries = (
  app: FastifyInstance,
  limit = 50
): readonly ThreadSummary[] => {
  const sessionRepo = new DrizzleSessionRepository(app.infra.db);
  const runningSessionIds = new Set(
    new DrizzleRunRepository(app.infra.db).listRunningSessionIds()
  );

  return sessionRepo.listAll(limit).map((thread) => {
    const countRow = app.infra.db
      .select({
        count: sql<number>`count(*)`
      })
      .from(messages)
      .where(eq(messages.sessionId, thread.id))
      .get();

    return {
      id: thread.id,
      title: thread.title,
      model: thread.model,
      origin: thread.origin,
      updatedAt: thread.updatedAt,
      messageCount: Number(countRow?.count ?? 0),
      workspaceId: thread.workspaceId,
      status: deriveSessionStatus({
        hasPendingApproval:
          app.services.approvals.listPending(thread.id).length > 0,
        hasRunningRun: runningSessionIds.has(thread.id)
      })
    };
  });
};

export const registerThreadRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/threads", async (request): Promise<readonly ThreadSummary[]> => {
    const query = listThreadsQuerySchema.parse(request.query ?? {});
    return listThreadSummaries(app, query.limit ?? 50);
  });

  app.post("/api/v1/threads", async (request, reply): Promise<ThreadSummary> => {
    const body = createThreadSchema.parse(request.body ?? {});
    const repo = new DrizzleSessionRepository(app.infra.db);
    const thread = repo.create({
      id: randomUUID(),
      sessionKey: randomUUID(),
      ...(body.title ? { title: body.title } : {})
    });

    reply.code(201);

    return {
      id: thread.id,
      title: thread.title,
      model: thread.model,
      origin: thread.origin,
      updatedAt: thread.updatedAt,
      messageCount: 0,
      workspaceId: thread.workspaceId,
      status: "idle"
    };
  });

  app.put(
    "/api/v1/threads/:id/workspace",
    async (request, reply): Promise<ThreadSummary | { error: string }> => {
      const { id } = request.params as { id: string };
      const body = setThreadWorkspaceSchema.parse(request.body ?? {});
      const sessionRepo = new DrizzleSessionRepository(app.infra.db);

      const updated = sessionRepo.updateWorkspace(id, body.workspaceId);

      if (!updated) {
        reply.code(404);
        return { error: "Thread not found" };
      }

      return listThreadSummaries(app, 1000).find((item) => item.id === id)!;
    }
  );

  app.delete("/api/v1/threads/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = new DrizzleSessionRepository(app.infra.db);
    const deleted = repo.deleteById(id);

    if (!deleted) {
      reply.code(404);
      return { error: "Thread not found" };
    }

    reply.code(204);
    return null;
  });

  app.post(
    "/api/v1/threads/:id/compact",
    async (request, reply): Promise<ThreadCompactResult | { error: string }> => {
      const { id } = request.params as { id: string };
      const sessionRepo = new DrizzleSessionRepository(app.infra.db);
      const thread = sessionRepo.findById(id);

      if (!thread) {
        reply.code(404);
        return { error: "Thread not found" };
      }

      // 手动压缩同样用 tool 槽位模型写摘要;模型没配好时不注入 summarizer,
      // compactSession 回落确定性拼接 —— 摘要质量可以降级,这条路由不能挂。
      let summarize: ReturnType<typeof createModelSummarizer> | undefined;
      try {
        const tool = app.services.agents.resolveModels().tool;
        summarize = createModelSummarizer(tool, app.log);
      } catch {
        summarize = undefined;
      }

      const result = await compactSession(app.infra.db, {
        sessionId: id,
        trigger: "manual",
        ...(summarize ? { summarize } : {})
      });

      const updatedThread = listThreadSummaries(app, 1000).find((item) => item.id === id) ?? {
        id: thread.id,
        title: thread.title,
        model: thread.model,
        origin: thread.origin,
        updatedAt: thread.updatedAt,
        messageCount: app.infra.db
          .select({ count: sql<number>`count(*)` })
          .from(messages)
          .where(eq(messages.sessionId, thread.id))
          .get()?.count ?? 0,
        workspaceId: thread.workspaceId,
        status: "idle"
      };

      return {
        success: true,
        compacted: result.compacted,
        trigger: "manual",
        coveredMessageCount: result.coveredMessageCount,
        preservedTailMessageCount: result.preservedTailMessageCount,
        estimatedTokensBefore: result.estimatedTokensBefore,
        estimatedTokensAfter: result.estimatedTokensAfter,
        ...(result.compactionId ? { compactionId: result.compactionId } : {}),
        thread: updatedThread
      };
    }
  );

  app.get("/api/v1/threads/:id/status", async (request, reply): Promise<ThreadStatus | { error: string }> => {
    const { id } = request.params as { id: string };
    const sessionRepo = new DrizzleSessionRepository(app.infra.db);
    const thread = sessionRepo.findById(id);

    if (!thread) {
      reply.code(404);
      return { error: "Thread not found" };
    }

    return readSessionRuntimeStatus(app.infra.db, app.services.approvals, id);
  });

  app.get("/api/v1/threads/:id/usage", async (request, reply): Promise<ThreadUsage | { error: string }> => {
    const { id } = request.params as { id: string };
    const sessionRepo = new DrizzleSessionRepository(app.infra.db);
    const thread = sessionRepo.findById(id);

    if (!thread) {
      reply.code(404);
      return { error: "Thread not found" };
    }

    return readSessionUsage(app.infra.db, app.infra.config, app.services.session, id);
  });

  app.get("/api/v1/threads/:id/messages", async (request, reply): Promise<readonly ThreadMessage[] | { error: string }> => {
    const { id } = request.params as { id: string };
    const query = getThreadMessagesQuerySchema.parse(request.query ?? {});
    const sessionRepo = new DrizzleSessionRepository(app.infra.db);
    const thread = sessionRepo.findById(id);

    if (!thread) {
      reply.code(404);
      return { error: "Thread not found" };
    }

    const messageRepo = new DrizzleMessageRepository(app.infra.db);

    return messageRepo.findBySessionId(id, { limit: query.limit ?? 200 }).map((message) => ({
      id: message.id,
      role: message.role,
      message: message.message,
      runId: message.runId,
      createdAt: message.createdAt
    }));
  });
};
