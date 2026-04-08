import type { AppDatabase } from "../db/index.js";
import { DrizzleMessageRepository } from "../db/repositories/message-repository.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { SessionCompactionRepository } from "../db/repositories/session-compaction-repository.js";
import { compactSession, type CompactResult } from "./compact.js";
import { estimateHistoryTokens } from "./token-estimator.js";
import { SessionService } from "./session.js";

const DEFAULT_TOKEN_THRESHOLD = 80_000;
const DEFAULT_MESSAGE_THRESHOLD = 30;
const DEFAULT_KEEP_RECENT = 8;

export interface AutoCompactConfig {
  readonly enabled: boolean;
  readonly tokenThreshold: number;
  readonly messageCountThreshold: number;
  readonly keepRecentMessages: number;
}

export const createAutoCompactConfig = (settings?: {
  autoCompact?: boolean;
  autoCompactTokenThreshold?: number;
  autoCompactMessageThreshold?: number;
}): AutoCompactConfig => ({
  enabled: settings?.autoCompact ?? true,
  tokenThreshold: settings?.autoCompactTokenThreshold ?? DEFAULT_TOKEN_THRESHOLD,
  messageCountThreshold: settings?.autoCompactMessageThreshold ?? DEFAULT_MESSAGE_THRESHOLD,
  keepRecentMessages: DEFAULT_KEEP_RECENT
});

export interface AutoCompactResult {
  readonly compacted: boolean;
  readonly compactResult?: CompactResult;
  readonly estimatedTokensBefore?: number;
}

/**
 * Check if a session's history exceeds the configured thresholds
 * and run non-destructive compact if so.
 *
 * This writes to `session_compactions` — it does NOT delete messages.
 * The caller should use `buildModelHistory()` after this to get the
 * compacted context view for the agent.
 */
export const autoCompactIfNeeded = (
  db: AppDatabase,
  sessionId: string,
  history: readonly { content: string }[],
  config: AutoCompactConfig
): AutoCompactResult => {
  if (!config.enabled) {
    return { compacted: false };
  }

  const compactionRepo = new SessionCompactionRepository(db);
  const existingCompaction = compactionRepo.findBySessionId(sessionId);
  const sessionService = existingCompaction
    ? new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    )
    : undefined;
  const historyForThreshold = existingCompaction
    ? sessionService!.buildModelHistory(db, sessionId)
    : history;
  const estimatedTokens = estimateHistoryTokens(historyForThreshold);
  const messageCount = historyForThreshold.length;

  const shouldCompact =
    estimatedTokens > config.tokenThreshold ||
    messageCount > config.messageCountThreshold;

  if (!shouldCompact) {
    return { compacted: false, estimatedTokensBefore: estimatedTokens };
  }

  const compactResult = compactSession(db, {
    sessionId,
    keepRecentMessages: config.keepRecentMessages,
    trigger: "proactive"
  });

  return {
    compacted: compactResult.compacted,
    compactResult,
    estimatedTokensBefore: estimatedTokens
  };
};
