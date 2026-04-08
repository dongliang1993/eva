import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent
} from "@langchain/core/messages";

import type { AgentTool } from "../tools.js";
import type { ContextWindowPolicy } from "./policy.js";

const TOOL_RESULT_BUDGET_NOTICE = "Tool result omitted due to context budget.";
const ESTIMATED_CHARS_PER_TOKEN = 4;

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

const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN));

const isTrimmedToolResult = (content: string): boolean =>
  content.startsWith(`[${TOOL_RESULT_BUDGET_NOTICE}]`);

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

const buildTrimmedToolMessage = (
  message: ToolMessage,
  toolName: string | undefined,
  originalContent: string
): ToolMessage =>
  new ToolMessage({
    content: [
      `[${TOOL_RESULT_BUDGET_NOTICE}]`,
      `Tool: ${toolName ?? "unknown"}`,
      `Tool call ID: ${message.tool_call_id}`,
      `Status: ${message.status ?? "success"}`,
      `Original output length: ${originalContent.length} chars`
    ].join(" "),
    tool_call_id: message.tool_call_id,
    status: message.status ?? "success"
  });

interface ToolMessageBudgetCandidate {
  readonly index: number;
  readonly message: ToolMessage;
  readonly toolName?: string;
  readonly content: string;
  readonly estimatedTokens: number;
}

export const applyToolResultBudget = (
  messages: readonly BaseMessage[],
  tools: ReadonlyMap<string, AgentTool>,
  policy: ContextWindowPolicy
): BaseMessage[] => {
  if (policy.toolResultBudgetTokens <= 0) {
    return [...messages];
  }

  const protectedToolCallIds = new Set<string>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (!(message instanceof ToolMessage)) {
      break;
    }

    protectedToolCallIds.add(message.tool_call_id);
  }

  const toolNameByCallId = buildToolNameByCallId(messages);
  const returnDirectToolNames = new Set(
    [...tools.values()]
      .filter((tool) => "returnDirect" in tool && tool.returnDirect === true)
      .map((tool) => tool.name)
  );

  const candidates: ToolMessageBudgetCandidate[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (!(message instanceof ToolMessage)) {
      continue;
    }

    const toolName = toolNameByCallId.get(message.tool_call_id);

    if (protectedToolCallIds.has(message.tool_call_id)) {
      continue;
    }

    if (toolName && returnDirectToolNames.has(toolName)) {
      continue;
    }

    const content = stringifyContent(message.content);

    if (content.length === 0 || isTrimmedToolResult(content)) {
      continue;
    }

    candidates.push({
      index,
      message,
      content,
      estimatedTokens: estimateTokens(content),
      ...(toolName !== undefined ? { toolName } : {})
    });
  }

  let totalCandidateTokens = candidates.reduce(
    (sum, candidate) => sum + candidate.estimatedTokens,
    0
  );

  if (totalCandidateTokens <= policy.toolResultBudgetTokens) {
    return [...messages];
  }

  const trimmedIndexes = new Set<number>();

  for (const candidate of candidates) {
    trimmedIndexes.add(candidate.index);
    totalCandidateTokens -= candidate.estimatedTokens;

    if (totalCandidateTokens <= policy.toolResultBudgetTokens) {
      break;
    }
  }

  return messages.map((message, index) => {
    if (!(message instanceof ToolMessage) || !trimmedIndexes.has(index)) {
      return message;
    }

    const candidate = candidates.find((item) => item.index === index);

    if (!candidate) {
      return message;
    }

    return buildTrimmedToolMessage(
      candidate.message,
      candidate.toolName,
      candidate.content
    );
  });
};
