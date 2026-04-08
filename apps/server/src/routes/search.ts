import { desc, inArray, like, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ThreadSearchResult } from "@eva/shared";

import { DrizzleMessageSearchRepository } from "../db/repositories/message-search-repository.js";
import { messages, sessions } from "../db/schema.js";

const searchThreadsQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional()
});

const MAX_SNIPPET_LENGTH = 160;

const normalizeSnippet = (content: string): string => {
  const compact = content.replace(/\s+/g, " ").trim();

  if (compact.length <= MAX_SNIPPET_LENGTH) {
    return compact;
  }

  return `${compact.slice(0, MAX_SNIPPET_LENGTH - 3)}...`;
};

export const registerSearchRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/search/threads", async (request): Promise<readonly ThreadSearchResult[]> => {
    const query = searchThreadsQuerySchema.parse(request.query ?? {});
    const q = query.q?.trim() ?? "";
    const limit = query.limit ?? 20;

    if (q.length === 0) {
      return [];
    }

    const titleMatches = app.infra.db
      .select()
      .from(sessions)
      .where(like(sessions.title, `%${q}%`))
      .orderBy(desc(sessions.updatedAt))
      .limit(limit)
      .all();

    const messageHits = new DrizzleMessageSearchRepository(app.infra.db).search(
      q,
      limit * 5
    );

    const orderedIds: string[] = [];
    const seen = new Set<string>();
    const snippetsByThreadId = new Map<string, string>();

    for (const thread of titleMatches) {
      if (!seen.has(thread.id)) {
        seen.add(thread.id);
        orderedIds.push(thread.id);
      }
    }

    for (const hit of messageHits) {
      if (!snippetsByThreadId.has(hit.sessionId)) {
        snippetsByThreadId.set(hit.sessionId, normalizeSnippet(hit.content));
      }

      if (!seen.has(hit.sessionId)) {
        seen.add(hit.sessionId);
        orderedIds.push(hit.sessionId);
      }
    }

    const limitedIds = orderedIds.slice(0, limit);

    if (limitedIds.length === 0) {
      return [];
    }

    const matchedThreads = app.infra.db
      .select()
      .from(sessions)
      .where(inArray(sessions.id, limitedIds))
      .all();

    const counts = app.infra.db
      .select({
        sessionId: messages.sessionId,
        count: sql<number>`count(*)`
      })
      .from(messages)
      .where(inArray(messages.sessionId, limitedIds))
      .groupBy(messages.sessionId)
      .all();

    const threadsById = new Map(matchedThreads.map((thread) => [thread.id, thread]));
    const messageCountByThreadId = new Map(
      counts.map((row) => [row.sessionId, Number(row.count ?? 0)])
    );

    return limitedIds.flatMap((threadId) => {
      const thread = threadsById.get(threadId);

      if (!thread) {
        return [];
      }

      const snippet = snippetsByThreadId.get(thread.id);

      return [{
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
        messageCount: messageCountByThreadId.get(thread.id) ?? 0,
        ...(snippet ? { snippet } : {})
      }];
    });
  });
};
