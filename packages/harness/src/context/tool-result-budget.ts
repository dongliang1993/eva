import type {
  ModelMessage,
  ToolModelMessage,
  ToolResultPart
} from "ai";

import type { ContextWindowPolicy } from "./policy.js";

const TOOL_RESULT_BUDGET_NOTICE = "Tool result omitted due to context budget.";
const ESTIMATED_CHARS_PER_TOKEN = 4;

// ToolResultPart.output 的类型(ai 没直接导出 ToolResultOutput,用索引取)。
type ToolResultOutput = ToolResultPart["output"];

// 把 ToolResultOutput 拍平成纯文本用于 token 估算和裁剪判断。
const stringifyToolOutput = (output: ToolResultOutput): string => {
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

const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN));

const isTrimmedToolResult = (text: string): boolean =>
  text.startsWith(`[${TOOL_RESULT_BUDGET_NOTICE}]`);

// 从 assistant message 的 content 数组里抽 tool-call part,建 toolCallId → toolName 映射。
const buildToolNameByCallId = (
  messages: readonly ModelMessage[]
): Map<string, string> => {
  const toolNameByCallId = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }

    for (const part of message.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "tool-call"
      ) {
        const toolCall = part as { toolCallId: string; toolName: string };
        toolNameByCallId.set(toolCall.toolCallId, toolCall.toolName);
      }
    }
  }

  return toolNameByCallId;
};

// 从 ToolModelMessage 的 content 里取第一个 tool-result part。
const readToolResultPart = (
  message: ToolModelMessage
): ToolResultPart | undefined =>
  message.content.find(
    (p): p is ToolResultPart =>
      typeof p === "object" && p !== null && "type" in p && p.type === "tool-result"
  );

const buildTrimmedToolResult = (
  original: ToolResultPart,
  originalText: string
): ToolResultPart => ({
  type: "tool-result",
  toolCallId: original.toolCallId,
  toolName: original.toolName,
  output: {
    type: "text",
    value: [
      `[${TOOL_RESULT_BUDGET_NOTICE}]`,
      `Tool call ID: ${original.toolCallId}`,
      `Original output length: ${originalText.length} chars`
    ].join(" ")
  }
});

interface ToolMessageBudgetCandidate {
  readonly index: number;
  readonly message: ToolModelMessage;
  readonly toolResult: ToolResultPart;
  readonly toolName?: string;
  readonly text: string;
  readonly estimatedTokens: number;
}

export const applyToolResultBudget = (
  messages: readonly ModelMessage[],
  _policy: ContextWindowPolicy
): ModelMessage[] => {
  const policy = _policy;
  if (policy.toolResultBudgetTokens <= 0) {
    return [...messages];
  }

  // 保护尾部连续的 tool message(最近的工具结果不裁剪)。
  const protectedToolCallIds = new Set<string>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "tool") {
      break;
    }
    const result = readToolResultPart(message);
    if (result) {
      protectedToolCallIds.add(result.toolCallId);
    }
  }

  const toolNameByCallId = buildToolNameByCallId(messages);

  const candidates: ToolMessageBudgetCandidate[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "tool") {
      continue;
    }

    const toolResult = readToolResultPart(message);
    if (!toolResult) {
      continue;
    }

    if (protectedToolCallIds.has(toolResult.toolCallId)) {
      continue;
    }

    const toolName = toolNameByCallId.get(toolResult.toolCallId);
    const text = stringifyToolOutput(toolResult.output);

    if (text.length === 0 || isTrimmedToolResult(text)) {
      continue;
    }

    candidates.push({
      index,
      message,
      toolResult,
      text,
      estimatedTokens: estimateTokens(text),
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
    if (!message || message.role !== "tool" || !trimmedIndexes.has(index)) {
      return message;
    }

    const candidate = candidates.find((item) => item.index === index);
    if (!candidate) {
      return message;
    }

    const trimmedPart = buildTrimmedToolResult(candidate.toolResult, candidate.text);

    // 重建 ToolModelMessage,只替换 tool-result part,保留其它 part。
    const newContent = message.content.map((part) =>
      typeof part === "object" && part !== null && "type" in part && part.type === "tool-result"
        ? trimmedPart
        : part
    );

    return { ...message, content: newContent } as ToolModelMessage;
  });
};
