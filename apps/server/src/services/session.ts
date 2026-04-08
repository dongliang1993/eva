import { randomUUID } from "node:crypto";

import type { AgentRunResult } from "@eva/harness";

import type { AppDatabase } from "../db/index.js";
import { SessionCompactionRepository } from "../db/repositories/session-compaction-repository.js";

import type {
  ISessionRepository,
  IMessageRepository,
  Session,
  Message,
  MessageContentBlock
} from "../db/repositories/types.js";
import {
  extractSearchText,
  parseMessageContent,
  serializeMessageContent
} from "../db/repositories/types.js";

export interface HistoryMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export interface ResolvedSession {
  readonly session: Session;
  readonly history: readonly HistoryMessage[];
  readonly isNew: boolean;
}

/**
 * Convert an AgentRunResult to structured content blocks for storage.
 */
const resultToContentBlocks = (
  result: AgentRunResult,
  thinkingDurationMs?: number
): readonly MessageContentBlock[] => {
  const blocks: MessageContentBlock[] = [];

  if (thinkingDurationMs !== undefined && thinkingDurationMs > 0) {
    blocks.push({ type: "thinking", durationMs: thinkingDurationMs });
  }

  for (const tc of result.toolCalls) {
    blocks.push({
      type: "tool_use",
      toolName: tc.toolName,
      toolCallId: tc.toolCallId ?? "",
      args: tc.args
    });
    blocks.push({
      type: "tool_result",
      toolName: tc.toolName,
      toolCallId: tc.toolCallId ?? "",
      output: tc.output,
      status: tc.status,
      ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {})
    });
  }

  if (result.text) {
    blocks.push({ type: "text", text: result.text });
  }

  return blocks;
};

/**
 * Convert stored message content blocks back to a flat string
 * suitable for the LLM's conversation history.
 */
/**
 * Strip legacy `[Called tool: ...]` / `[Tool ... success: ...]` markers
 * that may be embedded in old stored messages. These cause the LLM to
 * mimic the format and enter infinite tool-call loops.
 */
const stripToolMarkers = (text: string): string =>
  text
    .replace(/\[Called tool: [^\]]*\]/g, "")
    .replace(/\[Tool [^\]]*\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const blocksToHistoryContent = (blocks: readonly MessageContentBlock[]): string => {
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      // Omit tool_use/tool_result from history — exposing raw output
      // causes the LLM to mimic the format in subsequent turns.
      case "tool_use":
      case "tool_result":
        break;
    }
  }

  return stripToolMarkers(parts.join("\n"));
};

export class SessionService {
  constructor(
    private readonly sessions: ISessionRepository,
    private readonly messages: IMessageRepository
  ) {}

  buildFullHistory(sessionId: string): readonly HistoryMessage[] {
    const rawHistory = this.messages.findBySessionId(sessionId, {
      limit: 2000
    });

    return rawHistory.map((m) => ({
      role: m.role,
      content: m.role === "assistant"
        ? blocksToHistoryContent(parseMessageContent(m.content))
        : m.content
    }));
  }

  buildHistory(sessionId: string): readonly HistoryMessage[] {
    return this.buildFullHistory(sessionId);
  }

  /**
   * Build the model-visible history using compaction snapshots.
   * If a compaction exists, returns: [system summary] + [preserved tail messages].
   * Otherwise returns the full history (same as buildHistory).
   * Never deletes messages from DB.
   */
  buildModelHistory(db: AppDatabase, sessionId: string): readonly HistoryMessage[] {
    const compactionRepo = new SessionCompactionRepository(db);
    const compaction = compactionRepo.findBySessionId(sessionId);

    if (!compaction) {
      return this.buildFullHistory(sessionId);
    }

    // Load all messages to find the split point
    const allMessages = this.messages.findBySessionId(sessionId, { limit: 2000 });

    // Find the index of the covered-until message
    const coveredIdx = allMessages.findIndex((m) => m.id === compaction.coveredUntilMessageId);

    // Tail = everything after the covered-until message
    const tailMessages = coveredIdx >= 0
      ? allMessages.slice(coveredIdx + 1)
      : allMessages.slice(-compaction.preservedTailMessageCount);

    const tail: HistoryMessage[] = tailMessages.map((m) => ({
      role: m.role,
      content: m.role === "assistant"
        ? blocksToHistoryContent(parseMessageContent(m.content))
        : m.content
    }));

    // Prepend summary as system message
    return [
      { role: "system" as const, content: compaction.summary },
      ...tail
    ];
  }

  private appendUserMessage(sessionId: string, content: string): void {
    this.messages.create({
      id: randomUUID(),
      sessionId,
      role: "user",
      content,
      searchText: content
    });
    this.sessions.updateTimestamp(sessionId);
  }

  /**
   * Create a new session, record the first user message,
   * and return the session with history.
   */
  createSession(userContent: string): ResolvedSession {
    const session = this.sessions.create({
      id: randomUUID(),
      sessionKey: randomUUID(),
      title: userContent.slice(0, 50)
    });

    this.appendUserMessage(session.id, userContent);

    return {
      session,
      history: this.buildFullHistory(session.id),
      isNew: true
    };
  }

  /**
   * Append a user message to an existing session
   * and return the full history for the agent.
   * Returns undefined if session not found.
   */
  continueSession(
    sessionId: string,
    userContent: string
  ): ResolvedSession | undefined {
    const session = this.sessions.findById(sessionId);

    if (!session) {
      return undefined;
    }

    this.appendUserMessage(session.id, userContent);

    return {
      session,
      history: this.buildFullHistory(session.id),
      isNew: false
    };
  }

  /**
   * Resolve or create a session by key (for IM channels).
   * Uses sessionKey (e.g. thread_id, chat_id:sender_id) to find existing sessions.
   */
  resolveByKey(
    sessionKey: string,
    userContent: string,
    origin?: string
  ): ResolvedSession {
    const existing = this.sessions.findBySessionKey(sessionKey);

    if (existing) {
      this.appendUserMessage(existing.id, userContent);

      return {
        session: existing,
        history: this.buildFullHistory(existing.id),
        isNew: false
      };
    }

    const session = this.sessions.create({
      id: randomUUID(),
      sessionKey,
      title: userContent.slice(0, 50),
      ...(origin !== undefined ? { origin } : {})
    });

    this.appendUserMessage(session.id, userContent);

    return {
      session,
      history: this.buildFullHistory(session.id),
      isNew: true
    };
  }

  /**
   * Record the assistant's reply (with tool calls) in the session.
   */
  recordAssistantResult(
    sessionId: string,
    result: AgentRunResult,
    tokenUsage?: string,
    thinkingDurationMs?: number
  ): Message {
    const blocks = resultToContentBlocks(result, thinkingDurationMs);
    const content = serializeMessageContent(blocks);
    const searchText = extractSearchText(blocks);

    const message = this.messages.create({
      id: randomUUID(),
      sessionId,
      role: "assistant",
      content,
      searchText,
      ...(tokenUsage !== undefined ? { tokenUsage } : {})
    });

    this.sessions.updateTimestamp(sessionId);

    return message;
  }
}
