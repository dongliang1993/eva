export interface Session {
  readonly id: string;
  readonly title: string;
  readonly sessionKey: string;
  readonly model: string | null;
  readonly reasoningEffort: string;
  readonly origin: string;
  readonly toolPolicy: string;
  readonly skillPolicy: string;
  readonly memoryPolicy: string;
  readonly metadata: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly sessionKey: string;
  readonly title?: string;
  readonly origin?: string;
}

// ---------------------------------------------------------------------------
// Structured message content (stored as JSON in `content` column)
// ---------------------------------------------------------------------------

export type MessageContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly durationMs: number }
  | {
      readonly type: "tool_use";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly args: Record<string, unknown>;
    }
  | {
      readonly type: "tool_result";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly output: string;
      readonly status: "success" | "error";
      readonly durationMs?: number;
    };

/**
 * Parse the `content` column into structured blocks.
 * Handles both plain text (legacy) and JSON array formats.
 */
export const parseMessageContent = (content: string): readonly MessageContentBlock[] => {
  try {
    const parsed: unknown = JSON.parse(content);

    if (Array.isArray(parsed)) {
      return parsed as MessageContentBlock[];
    }
  } catch {
    // Not JSON — treat as plain text
  }

  return [{ type: "text", text: content }];
};

/**
 * Extract a plain-text search representation from content blocks.
 * Used to populate the `search_text` column for FTS indexing.
 */
export const extractSearchText = (blocks: readonly MessageContentBlock[]): string => {
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "tool_result":
        // Include tool output in search text for findability
        if (block.status === "success" && block.output.length <= 1000) {
          parts.push(block.output);
        }
        break;
    }
  }

  return parts.join(" ").trim();
};

/**
 * Serialize content blocks to a string for storage.
 * If content is only a single text block, store as plain text for readability.
 */
export const serializeMessageContent = (blocks: readonly MessageContentBlock[]): string => {
  if (blocks.length === 1 && blocks[0]!.type === "text") {
    return blocks[0]!.text;
  }

  return JSON.stringify(blocks);
};

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export interface Message {
  readonly id: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly searchText: string;
  readonly metadata: string;
  readonly tokenUsage: string | null;
  readonly createdAt: string;
}

export interface CreateMessageInput {
  readonly id: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly searchText?: string;
  readonly metadata?: string;
  readonly tokenUsage?: string;
}

export interface GetMessagesOptions {
  readonly limit?: number;
}

export interface ISessionRepository {
  create(input: CreateSessionInput): Session;
  findById(id: string): Session | undefined;
  findBySessionKey(sessionKey: string): Session | undefined;
  listAll(limit?: number): readonly Session[];
  updateTimestamp(id: string): void;
  updateTitle(id: string, title: string): void;
  updateModel(id: string, model: string): void;
  deleteById(id: string): boolean;
}

export interface IMessageRepository {
  create(input: CreateMessageInput): Message;
  findBySessionId(
    sessionId: string,
    options?: GetMessagesOptions
  ): readonly Message[];
  deleteBySessionId(sessionId: string): number;
}

