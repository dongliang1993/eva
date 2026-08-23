import type {
  AssistantModelMessage,
  ModelMessage,
  SystemModelMessage,
  ToolModelMessage,
  ToolResultPart,
  ToolCallPart,
  UserModelMessage
} from "ai";

import type { ContextWindowPolicy } from "./policy.js";

const ESTIMATED_CHARS_PER_TOKEN = 4;
// T37: 压缩产出对齐 Alma —— <context_summary> 包裹的 user 消息(不再是 system Runtime summary)。
const CONTEXT_SUMMARY_OPEN = "<context_summary>";
const CONTEXT_SUMMARY_CLOSE = "</context_summary>";
const MAX_SUMMARY_ITEMS = 8;
const MAX_SUMMARY_TEXT_LENGTH = 220;
const PRESERVED_RECENT_RUNTIME_MESSAGES = 4;
const PRESERVED_RECENT_REACTIVE_MESSAGES = 2;

/** T37 §2.3: 压缩后告诉模型「接着干,别从头再来」(Alma 的 system-reminder)。 */
const CONTEXT_SUMMARY_REMINDER =
  "Context was compacted. The <context_summary> above replaces earlier messages. " +
  "Continue from where the task left off — do NOT start over.";

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

/**
 * T36: 判定是否溢出。有上一步真实 usage 就用真值(Alma aA() 思路,main:90740
 * 步中用上一步 usage 判定),没有(首步)退回 chars/4 估算兜底。
 *
 * 阈值口径 = policy 的 softLimit(contextWindow - reservedOutput - loopCompactBuffer),
 * 与 applyProactiveLoopCompactWithStats 一致。严格大于才算溢出。
 */
export const isOverflowing = (
  messages: readonly ModelMessage[],
  policy: ContextWindowPolicy,
  lastStepInputTokens?: number
): boolean => {
  const softLimit = Math.max(
    0,
    policy.contextWindow
      - policy.reservedOutputTokens
      - policy.loopCompactBufferTokens
  );

  if (softLimit <= 0) {
    return false;
  }

  const tokens =
    lastStepInputTokens !== undefined
      ? lastStepInputTokens
      : estimateMessagesTokens(messages);

  return tokens > softLimit;
};

const isRuntimeSummaryMessage = (
  message: ModelMessage | undefined
): message is UserModelMessage =>
  message !== undefined
  && message.role === "user"
  && typeof message.content === "string"
  && message.content.startsWith(CONTEXT_SUMMARY_OPEN);

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

/** 从消息里抽 tool 涉及的文件路径(read/write/edit/list 的 path 参数)。 */
const extractFilePaths = (messages: readonly ModelMessage[]): string[] => {
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const tc of readToolCalls(message)) {
      const input = tc.input as Record<string, unknown> | undefined;
      const p = input?.path ?? input?.file ?? input?.filePath;
      if (typeof p === "string" && p) paths.add(p);
    }
  }
  return [...paths];
};

/**
 * T37 §2.2: 六段摘要结构(对齐 Alma main:71821 DO 常量的六段)。
 * 本地规则拼装(不引入 LLM 摘要成本),从 compactedMessages 抽取。
 */
const buildRuntimeSummary = (
  compactedMessages: readonly ModelMessage[],
  previousSummary: string | undefined
): string => {
  const toolNameByCallId = buildToolNameByCallId(compactedMessages);

  // 分段原料
  const userMessages = compactedMessages
    .filter((m) => m.role === "user")
    .map((m) => stringifyContent(m.content).trim())
    .filter(Boolean);
  const assistantPoints = compactedMessages
    .filter((m) => m.role === "assistant")
    .map((m) => summarizeMessage(m, toolNameByCallId))
    .filter((item): item is string => Boolean(item));
  const toolNotes = compactedMessages
    .filter((m) => m.role === "tool")
    .map((m) => summarizeMessage(m, toolNameByCallId))
    .filter((item): item is string => Boolean(item));
  const errors = compactedMessages
    .filter((m) => m.role === "tool" && readToolStatus(m) === "error")
    .map((m) => summarizeMessage(m, toolNameByCallId))
    .filter((item): item is string => Boolean(item));
  const filePaths = extractFilePaths(compactedMessages);

  const primaryRequest = userMessages[0] ?? "(无用户请求)";

  const sections: string[] = [];
  sections.push(`## Primary Request\n${normalizeSummaryText(primaryRequest)}`);
  sections.push(
    `## Key Technical Concepts\n${assistantPoints.length > 0 ? assistantPoints.slice(0, 4).map((s) => `- ${s}`).join("\n") : "- (无)"}`
  );
  sections.push(
    `## Files and Code\n${filePaths.length > 0 ? filePaths.map((p) => `- ${p}`).join("\n") : "- (无文件操作)"}`
  );
  sections.push(
    `## Errors and Fixes\n${errors.length > 0 ? errors.map((e) => `- ${e}`).join("\n") : "- (无错误)"}`
  );
  sections.push(
    `## Problem Solving\n${toolNotes.length > 0 ? toolNotes.slice(0, 4).map((s) => `- ${s}`).join("\n") : "- (无)"}`
  );
  // 用户意图最不能丢 —— 全量保留原文,不做摘要截断。
  sections.push(
    `## All User Messages\n${userMessages.map((u) => `- ${u}`).join("\n")}`
  );

  let body = sections.join("\n\n");

  // 二次 compact:把上一次 summary 并进来,不丢历史。
  if (previousSummary) {
    const prev = previousSummary
      .replace(CONTEXT_SUMMARY_OPEN, "")
      .replace(CONTEXT_SUMMARY_CLOSE, "")
      .trim();
    body = `${body}\n\n## Previously Compacted Context\n${prev}`;
  }

  return `${CONTEXT_SUMMARY_OPEN}\n${body}\n${CONTEXT_SUMMARY_CLOSE}`;
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
  policy: ContextWindowPolicy,
  lastStepInputTokens?: number
): RuntimeCompactResult => {
  const estimatedTokensBefore = estimateMessagesTokens(messages);

  // T36: 溢出判定真值优先(有上一步 usage 用它),首步无 usage 退回估算兜底。
  if (!isOverflowing(messages, policy, lastStepInputTokens)) {
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
  // 二次 compact:剥掉旧 summary(user)以及紧跟的旧 reminder(system),避免 reminder 越积越多。
  let runtimeMessages = existingSummary
    ? runtimeSegment.slice(1)
    : runtimeSegment;
  if (
    existingSummary &&
    runtimeMessages[0]?.role === "system" &&
    typeof runtimeMessages[0].content === "string" &&
    runtimeMessages[0].content === CONTEXT_SUMMARY_REMINDER
  ) {
    runtimeMessages = runtimeMessages.slice(1);
  }

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

  // T37: summary 用 user 消息装(留在历史原位,不被 context-strategy 上提);
  // reminder 用 system(会被上提到 instructions,提醒模型接着干)。
  // isRuntimeSummaryMessage 已保证 existingSummary.content 是 string(startsWith 判定过),收窄类型。
  const previousSummaryText =
    existingSummary && typeof existingSummary.content === "string"
      ? existingSummary.content
      : undefined;
  const summaryMessage: UserModelMessage = {
    role: "user",
    content: buildRuntimeSummary(compactedMessages, previousSummaryText)
  };
  const reminderMessage: SystemModelMessage = {
    role: "system",
    content: CONTEXT_SUMMARY_REMINDER
  };

  return buildRuntimeCompactResult(
    messages,
    [
      ...prefix,
      summaryMessage,
      reminderMessage,
      ...preservedTail
    ],
    true,
    estimatedTokensBefore
  );
};
