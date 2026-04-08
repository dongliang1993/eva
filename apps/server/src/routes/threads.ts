import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ThreadMessage, ThreadSummary } from "@eva/shared";

import { DrizzleMessageRepository } from "../db/repositories/message-repository.js";
import { parseMessageContent } from "../db/repositories/types.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { compactSession } from "../services/compact.js";
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

const listThreadSummaries = (
  app: FastifyInstance,
  limit = 50
): readonly ThreadSummary[] => {
  const sessionRepo = new DrizzleSessionRepository(app.infra.db);

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
      messageCount: Number(countRow?.count ?? 0)
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
      messageCount: 0
    };
  });

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

      const result = compactSession(app.infra.db, {
        sessionId: id,
        trigger: "manual"
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
          .get()?.count ?? 0
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
      content: message.content,
      createdAt: message.createdAt,
      metadata: message.metadata
    }));
  });
};
