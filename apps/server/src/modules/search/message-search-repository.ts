import { sql } from "drizzle-orm";

import type { AppDatabase } from "../../db/index.js";

export interface MessageSearchHit {
  readonly messageId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly rank: number;
}

export interface IMessageSearchRepository {
  search(query: string, limit?: number): readonly MessageSearchHit[];
  searchInSession(sessionId: string, query: string, limit?: number): readonly MessageSearchHit[];
}

/**
 * Full-text search over messages using SQLite FTS5.
 */
export class DrizzleMessageSearchRepository implements IMessageSearchRepository {
  constructor(private readonly db: AppDatabase) {}

  search(query: string, limit = 20): readonly MessageSearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];

    return this.db.all<MessageSearchHit>(
      sql`SELECT message_id AS messageId, session_id AS sessionId, content, rank
          FROM messages_fts
          WHERE messages_fts MATCH ${ftsQuery}
          ORDER BY rank
          LIMIT ${limit}`
    );
  }

  searchInSession(sessionId: string, query: string, limit = 20): readonly MessageSearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];

    return this.db.all<MessageSearchHit>(
      sql`SELECT message_id AS messageId, session_id AS sessionId, content, rank
          FROM messages_fts
          WHERE messages_fts MATCH ${ftsQuery} AND session_id = ${sessionId}
          ORDER BY rank
          LIMIT ${limit}`
    );
  }
}

/**
 * Convert a user query string to an FTS5 query.
 * Splits on whitespace and joins with implicit AND.
 * Escapes double quotes to prevent FTS injection.
 */
const toFtsQuery = (query: string): string | undefined => {
  const tokens = query
    .replace(/"/g, "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1);

  if (tokens.length === 0) return undefined;

  // Quote each token to handle special chars, join with implicit AND
  return tokens.map((t) => `"${t}"`).join(" ");
};
