import type {
  AssistantModelMessage,
  ModelMessage,
  SystemModelMessage,
  ToolModelMessage,
  ToolResultPart,
  ToolCallPart
} from "ai";

import type { ContextWindowPolicy } from "./policy.js";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const RUNTIME_SUMMARY_PREFIX = "Runtime summary:";
const MAX_SUMMARY_ITEMS = 8;
const MAX_SUMMARY_TEXT_LENGTH = 220;
const PRESERVED_RECENT_RUNTIME_MESSAGES = 4;
const PRESERVED_RECENT_REACTIVE_MESSAGES = 2;

export interface RuntimeCompactResult {
  readonly messages: ModelMessage[];
  readonly changed: boolean;
  readonly messageCountBefore: number;
  readonly messageCountAfter: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
}

// 把任意 message content(string | Array<part>)拍平成纯文本。
const stringifyContent = (content: unknown): string => {
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

        if (typeof item === "object" && item !== null) {
          const part = item as Record<string, unknown>;
          if (typeof part.text === "string") return part.text;
          if (part.type === "tool-call") {
            const tc = part as unknown as ToolCallPart;
            return JSON.stringify({ name: tc.toolName, args: tc.input });
          }
          if (part.type === "tool-result") {
            const tr = part as unknown as ToolResultPart;
            return stringifyToolOutput(tr.output);
          }
          return JSON.stringify(part);
        }

        return JSON.stringify(item);
      })
      .join("\n");
  }

  return JSON.stringify(content) ?? "";
};

const stringifyToolOutput = (output: ToolResultPart["output"]): string => {
  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return typeof output.value === "string" ? output.value : JSON.stringify(output.value);
    case "execution-denied":
      return `Execution denied${output.reason ? `: ${output.reason}` : ""}`;
    default:
      return JSON.stringify(output);
  }
};

const normalizeSummaryText = (text: string): string => {
  const compact = text.replace(/\s+/g, " ").trim();

  return compact.length <= MAX_SUMMARY_TEXT_LENGTH
    ? compact
    : `${compact.slice(0, MAX_SUMMARY_TEXT_LENGTH - 3)}...`;
};

// 从 assistant message content 里抽 tool-call part。
const readToolCalls = (message: AssistantModelMessage): ToolCallPart[] => {
  if (typeof message.content === "string") {
    return [];
  }
  return message.content.filter(
    (p): p is ToolCallPart =>
      typeof p === "object" && p !== null && "type" in p && p.type === "tool-call"
  );
};

// 从 tool message content 里取第一个 tool-result part。
const readToolResult = (message: ToolModelMessage): ToolResultPart | undefined =>
  message.content.find(
    (p): p is ToolResultPart =>
      typeof p === "object" && p !== null && "type" in p && p.type === "tool-result"
  );

const estimateMessageTokens = (message: ModelMessage): number => {
  let text = stringifyContent(message.content);

  if (message.role === "assistant") {
    const toolCalls = readToolCalls(message);
    if (toolCalls.length > 0) {
      text = [
        text,
        ...toolCalls.map((tc) => JSON.stringify({ name: tc.toolName, args: tc.input }))
      ].filter(Boolean).join("\n");
    }
  }

  return Math.max(1, Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN));
};

export const estimateMessagesTokens = (messages: readonly ModelMessage[]): number =>
  messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

const isRuntimeSummaryMessage = (
  message: ModelMessage | undefined
): message is SystemModelMessage =>
  message !== undefined
  && message.role === "system"
  && typeof message.content === "string"
  && message.content.startsWith(RUNTIME_SUMMARY_PREFIX);

const buildToolNameByCallId = (
  messages: readonly ModelMessage[]
): Map<string, string> => {
  const toolNameByCallId = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const toolCall of readToolCalls(message)) {
      toolNameByCallId.set(toolCall.toolCallId, toolCall.toolName);
    }
  }

  return toolNameByCallId;
};

// 从 tool result 的 output 文本判断状态(eva 的 buildTool 把错误包成 "Error: ..." 文本)。
const readToolStatus = (message: ToolModelMessage): "success" | "error" => {
  const result = readToolResult(message);
  if (!result) return "success";
  const text = stringifyToolOutput(result.output);
  return text.startsWith("Error:") ? "error" : "success";
};

const summarizeMessage = (
  message: ModelMessage,
  toolNameByCallId: ReadonlyMap<string, string>
): string | undefined => {
  if (message.role === "tool") {
    const result = readToolResult(message);
    const toolCallId = result?.toolCallId;
    const toolName = (toolCallId && toolNameByCallId.get(toolCallId)) ?? "unknown";
    const content = result ? normalizeSummaryText(stringifyToolOutput(result.output)) : "";
    const status = readToolStatus(message);

    if (!content) {
      return `Tool ${toolName} returned ${status} with empty output.`;
    }

    return `Tool ${toolName} returned (${status}): ${content}`;
  }

  if (message.role === "assistant") {
    const text = normalizeSummaryText(stringifyContent(message.content));
    const toolCalls = readToolCalls(message);

    if (toolCalls.length > 0) {
      const tools = toolCalls.map((tc) => tc.toolName).filter(Boolean);

      if (text) {
        return `Assistant: ${text} Tools requested: ${tools.join(", ") || "unknown"}.`;
      }

      return `Assistant requested tools: ${tools.join(", ") || "unknown"}.`;
    }

    return text ? `Assistant: ${text}` : undefined;
  }

  if (message.role === "user") {
    const text = normalizeSummaryText(stringifyContent(message.content));
    return text ? `User: ${text}` : undefined;
  }

  return undefined;
};

const buildRuntimeSummary = (
  compactedMessages: readonly ModelMessage[],
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
  beforeMessages: readonly ModelMessage[],
  nextMessages: ModelMessage[],
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
  messages: readonly ModelMessage[],
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
  messages: readonly ModelMessage[],
  prefixMessageCount: number,
  policy: ContextWindowPolicy
): ModelMessage[] =>
  applyProactiveLoopCompactWithStats(
    messages,
    prefixMessageCount,
    policy
  ).messages;

export const applyReactiveLoopCompactWithStats = (
  messages: readonly ModelMessage[],
  prefixMessageCount: number
): RuntimeCompactResult =>
  compactRuntimeMessages(
    messages,
    prefixMessageCount,
    PRESERVED_RECENT_REACTIVE_MESSAGES
  );

export const applyReactiveLoopCompact = (
  messages: readonly ModelMessage[],
  prefixMessageCount: number
): ModelMessage[] =>
  applyReactiveLoopCompactWithStats(messages, prefixMessageCount).messages;

const compactRuntimeMessages = (
  messages: readonly ModelMessage[],
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

  const summaryMessage: SystemModelMessage = {
    role: "system",
    content: buildRuntimeSummary(
      compactedMessages,
      existingSummary?.content
    )
  };

  return buildRuntimeCompactResult(
    messages,
    [
      ...prefix,
      summaryMessage,
      ...preservedTail
    ],
    true,
    estimatedTokensBefore
  );
};
