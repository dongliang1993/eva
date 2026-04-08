import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent
} from "@langchain/core/messages";

import type { ContextWindowPolicy } from "./policy.js";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const RUNTIME_SUMMARY_PREFIX = "Runtime summary:";
const MAX_SUMMARY_ITEMS = 8;
const MAX_SUMMARY_TEXT_LENGTH = 220;
const PRESERVED_RECENT_RUNTIME_MESSAGES = 4;
const PRESERVED_RECENT_REACTIVE_MESSAGES = 2;

export interface RuntimeCompactResult {
  readonly messages: BaseMessage[];
  readonly changed: boolean;
  readonly messageCountBefore: number;
  readonly messageCountAfter: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
}

const stringifyContent = (content: MessageContent): string => {
  if (content === undefined || content === null) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (
          typeof item === "object" &&
          item !== null &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          return item.text;
        }

        return JSON.stringify(item);
      })
      .join("\n");
  }

  return JSON.stringify(content) ?? "";
};

const normalizeSummaryText = (text: string): string => {
  const compact = text.replace(/\s+/g, " ").trim();

  return compact.length <= MAX_SUMMARY_TEXT_LENGTH
    ? compact
    : `${compact.slice(0, MAX_SUMMARY_TEXT_LENGTH - 3)}...`;
};

const estimateMessageTokens = (message: BaseMessage): number => {
  let text = stringifyContent(message.content);

  if (message instanceof AIMessage && message.tool_calls && message.tool_calls.length > 0) {
    text = [
      text,
      ...message.tool_calls.map((toolCall) =>
        JSON.stringify({
          name: toolCall.name,
          args: toolCall.args
        })
      )
    ].filter(Boolean).join("\n");
  }

  return Math.max(1, Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN));
};

export const estimateMessagesTokens = (messages: readonly BaseMessage[]): number =>
  messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

const isRuntimeSummaryMessage = (message: BaseMessage | undefined): message is SystemMessage =>
  message instanceof SystemMessage
  && typeof message.content === "string"
  && message.content.startsWith(RUNTIME_SUMMARY_PREFIX);

const buildToolNameByCallId = (
  messages: readonly BaseMessage[]
): Map<string, string> => {
  const toolNameByCallId = new Map<string, string>();

  for (const message of messages) {
    if (!(message instanceof AIMessage) || !message.tool_calls) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.id && toolCall.name) {
        toolNameByCallId.set(toolCall.id, toolCall.name);
      }
    }
  }

  return toolNameByCallId;
};

const summarizeMessage = (
  message: BaseMessage,
  toolNameByCallId: ReadonlyMap<string, string>
): string | undefined => {
  if (message instanceof ToolMessage) {
    const toolName = toolNameByCallId.get(message.tool_call_id) ?? "unknown";
    const content = normalizeSummaryText(stringifyContent(message.content));

    if (!content) {
      return `Tool ${toolName} returned ${message.status ?? "success"} with empty output.`;
    }

    return `Tool ${toolName} returned (${message.status ?? "success"}): ${content}`;
  }

  if (message instanceof AIMessage) {
    const text = normalizeSummaryText(stringifyContent(message.content));

    if (message.tool_calls && message.tool_calls.length > 0) {
      const tools = message.tool_calls.map((toolCall) => toolCall.name).filter(Boolean);

      if (text) {
        return `Assistant: ${text} Tools requested: ${tools.join(", ") || "unknown"}.`;
      }

      return `Assistant requested tools: ${tools.join(", ") || "unknown"}.`;
    }

    return text ? `Assistant: ${text}` : undefined;
  }

  if (message instanceof HumanMessage) {
    const text = normalizeSummaryText(stringifyContent(message.content));
    return text ? `User: ${text}` : undefined;
  }

  return undefined;
};

const buildRuntimeSummary = (
  compactedMessages: readonly BaseMessage[],
  previousSummary: string | undefined
): string => {
  const toolNameByCallId = buildToolNameByCallId(compactedMessages);
  const summaryItems = compactedMessages
    .map((message) => summarizeMessage(message, toolNameByCallId))
    .filter((item): item is string => Boolean(item))
    .slice(-MAX_SUMMARY_ITEMS);

  const lines: string[] = [RUNTIME_SUMMARY_PREFIX];

  if (previousSummary) {
    const normalizedPreviousSummary = normalizeSummaryText(
      previousSummary.replace(RUNTIME_SUMMARY_PREFIX, "").trim()
    );

    lines.push("");
    lines.push("Previously compacted context:");
    lines.push(`- ${normalizedPreviousSummary}`);
  }

  if (summaryItems.length === 0) {
    lines.push("");
    lines.push("- Earlier runtime context was compacted.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Earlier runtime context:");
  lines.push(...summaryItems.map((item) => `- ${item}`));

  return lines.join("\n");
};

const buildRuntimeCompactResult = (
  beforeMessages: readonly BaseMessage[],
  nextMessages: BaseMessage[],
  changed: boolean,
  estimatedTokensBefore = estimateMessagesTokens(beforeMessages)
): RuntimeCompactResult => ({
  messages: nextMessages,
  changed,
  messageCountBefore: beforeMessages.length,
  messageCountAfter: nextMessages.length,
  estimatedTokensBefore,
  estimatedTokensAfter: changed
    ? estimateMessagesTokens(nextMessages)
    : estimatedTokensBefore
});

export const applyProactiveLoopCompactWithStats = (
  messages: readonly BaseMessage[],
  prefixMessageCount: number,
  policy: ContextWindowPolicy
): RuntimeCompactResult => {
  const estimatedTokensBefore = estimateMessagesTokens(messages);
  const softLimit = Math.max(
    0,
    policy.contextWindow
      - policy.reservedOutputTokens
      - policy.loopCompactBufferTokens
  );

  if (softLimit <= 0 || estimatedTokensBefore <= softLimit) {
    return buildRuntimeCompactResult(
      messages,
      [...messages],
      false,
      estimatedTokensBefore
    );
  }

  return compactRuntimeMessages(
    messages,
    prefixMessageCount,
    PRESERVED_RECENT_RUNTIME_MESSAGES,
    estimatedTokensBefore
  );
};

export const applyProactiveLoopCompact = (
  messages: readonly BaseMessage[],
  prefixMessageCount: number,
  policy: ContextWindowPolicy
): BaseMessage[] =>
  applyProactiveLoopCompactWithStats(
    messages,
    prefixMessageCount,
    policy
  ).messages;

export const applyReactiveLoopCompactWithStats = (
  messages: readonly BaseMessage[],
  prefixMessageCount: number
): RuntimeCompactResult =>
  compactRuntimeMessages(
    messages,
    prefixMessageCount,
    PRESERVED_RECENT_REACTIVE_MESSAGES
  );

export const applyReactiveLoopCompact = (
  messages: readonly BaseMessage[],
  prefixMessageCount: number
): BaseMessage[] =>
  applyReactiveLoopCompactWithStats(messages, prefixMessageCount).messages;

const compactRuntimeMessages = (
  messages: readonly BaseMessage[],
  prefixMessageCount: number,
  preservedRecentRuntimeMessages: number,
  estimatedTokensBefore = estimateMessagesTokens(messages)
): RuntimeCompactResult => {
  if (preservedRecentRuntimeMessages < 0) {
    return buildRuntimeCompactResult(
      messages,
      [...messages],
      false,
      estimatedTokensBefore
    );
  }

  const prefix = messages.slice(0, prefixMessageCount);
  const runtimeSegment = messages.slice(prefixMessageCount);
  const existingSummary = isRuntimeSummaryMessage(runtimeSegment[0])
    ? runtimeSegment[0]
    : undefined;
  const runtimeMessages = existingSummary
    ? runtimeSegment.slice(1)
    : runtimeSegment;

  if (runtimeMessages.length <= preservedRecentRuntimeMessages) {
    return buildRuntimeCompactResult(
      messages,
      [...messages],
      false,
      estimatedTokensBefore
    );
  }

  const compactedMessages = runtimeMessages.slice(
    0,
    -preservedRecentRuntimeMessages
  );
  const preservedTail = runtimeMessages.slice(-preservedRecentRuntimeMessages);

  if (compactedMessages.length === 0) {
    return buildRuntimeCompactResult(
      messages,
      [...messages],
      false,
      estimatedTokensBefore
    );
  }

  return buildRuntimeCompactResult(
    messages,
    [
      ...prefix,
      new SystemMessage(
        buildRuntimeSummary(
          compactedMessages,
          existingSummary?.content as string | undefined
        )
      ),
      ...preservedTail
    ],
    true,
    estimatedTokensBefore
  );
};
