import { randomUUID } from "node:crypto";

import { isDynamicToolPart, isTextPart, toolPartOutput } from "@eva/shared";

import type { AppDatabase } from "../db/index.js";
import { DrizzleMessageRepository } from "../db/repositories/message-repository.js";
import { SessionCompactionRepository } from "../db/repositories/session-compaction-repository.js";
import type { StoredMessage } from "../db/repositories/types.js";
import {
  estimateTokens,
  estimateUiMessageTokens
} from "./token-estimator.js";

const DEFAULT_KEEP_RECENT = 8;
const MAX_SUMMARY_BULLETS = 4;
const MAX_SUMMARY_TEXT_LENGTH = 220;

// ---------------------------------------------------------------------------
// Summary generation (deterministic, no LLM)
// ---------------------------------------------------------------------------

const normalizeSummaryText = (text: string): string => {
  const compact = text.replace(/\s+/g, " ").trim();

  return compact.length <= MAX_SUMMARY_TEXT_LENGTH
    ? compact
    : `${compact.slice(0, MAX_SUMMARY_TEXT_LENGTH - 3)}...`;
};

const messageToSummaryText = (message: StoredMessage): string => {
  const chunks: string[] = [];

  for (const part of message.message.parts) {
    if (isTextPart(part)) {
      if (part.text.trim().length > 0) {
        chunks.push(normalizeSummaryText(part.text));
      }
      continue;
    }

    if (isDynamicToolPart(part)) {
      chunks.push(
        normalizeSummaryText(`[${part.toolName}] ${toolPartOutput(part)}`)
      );
    }
  }

  return chunks.join(" ").trim();
};

const estimateStoredTokens = (messages: readonly StoredMessage[]): number =>
  messages.reduce((sum, m) => sum + estimateUiMessageTokens(m.message), 0);

const generateSummaryText = (
  coveredMessages: readonly StoredMessage[],
  existingSummary?: string
): string => {
  if (coveredMessages.length === 0) {
    return existingSummary ?? "Conversation summary: no additional messages compacted.";
  }

  const userHighlights = coveredMessages
    .filter((m) => m.role === "user")
    .map((m) => messageToSummaryText(m))
    .filter((t) => t.length > 0)
    .slice(-MAX_SUMMARY_BULLETS);
  const assistantHighlights = coveredMessages
    .filter((m) => m.role === "assistant")
    .map((m) => messageToSummaryText(m))
    .filter((t) => t.length > 0)
    .slice(-MAX_SUMMARY_BULLETS);

  const lines: string[] = [];

  if (existingSummary) {
    lines.push(existingSummary);
    lines.push("");
  }

  lines.push(`Conversation summary (${coveredMessages.length} messages compacted):`);

  if (userHighlights.length > 0) {
    lines.push("User discussed:");
    lines.push(...userHighlights.map((t) => `- ${t}`));
  }

  if (assistantHighlights.length > 0) {
    lines.push("Assistant covered:");
    lines.push(...assistantHighlights.map((t) => `- ${t}`));
  }

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompactResult {
  readonly compacted: boolean;
  readonly coveredMessageCount: number;
  readonly preservedTailMessageCount: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly compactionId?: string;
}

export interface CompactOptions {
  readonly sessionId: string;
  readonly keepRecentMessages?: number;
  readonly trigger?: string;
}

/**
 * Non-destructive compact: generates a summary snapshot in `session_compactions`.
 * Does NOT delete any messages from the DB.
 * The summary is used by `buildModelHistory()` to construct the agent's context view.
 */
export const compactSession = (
  db: AppDatabase,
  options: CompactOptions
): CompactResult => {
  const { sessionId, keepRecentMessages = DEFAULT_KEEP_RECENT, trigger = "auto" } = options;
  const messageRepo = new DrizzleMessageRepository(db);
  const compactionRepo = new SessionCompactionRepository(db);

  const allMessages = messageRepo.findBySessionId(sessionId, { limit: 2000 });

  if (allMessages.length <= keepRecentMessages) {
    return {
      compacted: false,
      coveredMessageCount: 0,
      preservedTailMessageCount: allMessages.length,
      estimatedTokensBefore: estimateStoredTokens(allMessages),
      estimatedTokensAfter: estimateStoredTokens(allMessages)
    };
  }

  const tail = allMessages.slice(-keepRecentMessages);
  const covered = allMessages.slice(0, -keepRecentMessages);
  const coveredUntilMessage = covered[covered.length - 1]!;

  // Check for existing compaction — use its summary as base for incremental compact
  const existing = compactionRepo.findBySessionId(sessionId);
  const existingSummary = existing?.summary;

  // Only summarize messages that are NEW since last compaction
  let messagesToSummarize: readonly StoredMessage[];
  if (existing) {
    const coveredUntilIdx = covered.findIndex((m) => m.id === existing.coveredUntilMessageId);
    messagesToSummarize = coveredUntilIdx >= 0
      ? covered.slice(coveredUntilIdx + 1)
      : covered;
  } else {
    messagesToSummarize = covered;
  }

  const summary = generateSummaryText(messagesToSummarize, existingSummary);

  const estimatedTokensBefore = estimateStoredTokens(allMessages);
  const estimatedTokensAfter = estimateTokens(summary) + estimateStoredTokens(tail);

  if (
    existing &&
    messagesToSummarize.length === 0 &&
    existing.coveredUntilMessageId === coveredUntilMessage.id
  ) {
    return {
      compacted: false,
      coveredMessageCount: existing.coveredMessageCount,
      preservedTailMessageCount: tail.length,
      estimatedTokensBefore,
      estimatedTokensAfter,
      compactionId: existing.id
    };
  }

  const compactionId = randomUUID();

  compactionRepo.upsert({
    id: compactionId,
    sessionId,
    summary,
    coveredUntilMessageId: coveredUntilMessage.id,
    coveredMessageCount: covered.length,
    preservedTailMessageCount: tail.length,
    estimatedTokensBefore,
    estimatedTokensAfter,
    trigger
  });

  return {
    compacted: true,
    coveredMessageCount: covered.length,
    preservedTailMessageCount: tail.length,
    estimatedTokensBefore,
    estimatedTokensAfter,
    compactionId
  };
};
