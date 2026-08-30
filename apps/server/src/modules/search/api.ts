import { desc, inArray, like, sql } from "drizzle-orm";
import type { ThreadSearchResult } from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import { messages, sessions } from "../../db/schema.js";
import type { DrizzleMessageSearchRepository } from "./message-search-repository.js";

const MAX_SNIPPET_LENGTH = 160;

const normalizeSnippet = (content: string): string => {
  const compact = content.replace(/\s+/g, " ").trim();

  if (compact.length <= MAX_SNIPPET_LENGTH) {
    return compact;
  }

  return `${compact.slice(0, MAX_SNIPPET_LENGTH - 3)}...`;
};

export interface SearchApi {
  /**
   * 会话搜索:标题 LIKE 命中在前,正文 FTS 命中在后,同一会话只出现一次。
   * 空查询返回空数组(不是"全部")—— 搜索框刚聚焦时不该刷出整个历史。
   */
  searchThreads(query: string, limit: number): readonly ThreadSearchResult[];
}

export const createSearchApi = (deps: {
  readonly db: AppDatabase;
  readonly messageSearch: DrizzleMessageSearchRepository;
}): SearchApi => ({
  searchThreads: (query, limit) => {
    const q = query.trim();

    if (q.length === 0) {
      return [];
    }

    const titleMatches = deps.db
      .select()
      .from(sessions)
      .where(like(sessions.title, `%${q}%`))
      .orderBy(desc(sessions.updatedAt))
      .limit(limit)
      .all();

    // 正文取 limit*5:同一会话的多条命中会被折叠成一条结果,取窄了会让
    // 「命中很多但都在少数会话里」这种查询只返回个别结果。
    const messageHits = deps.messageSearch.search(q, limit * 5);

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

    const matchedThreads = deps.db
      .select()
      .from(sessions)
      .where(inArray(sessions.id, limitedIds))
      .all();

    const counts = deps.db
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
  }
});
