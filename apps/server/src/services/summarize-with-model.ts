import { generateText } from "ai";

import { isDynamicToolPart, isTextPart, toolPartOutput } from "@eva/shared";
import { toAgentModel } from "./agent-factory.js";
import type { ModelBinding } from "./providers/model-resolver.js";
import type { StoredMessage } from "../db/repositories/types.js";

export type SummarizeMessages = (
  messages: readonly StoredMessage[],
  previousSummary: string | undefined
) => Promise<string>;

/** 结构化 warn 即可 —— 兼容 Fastify 的 logger 与 pino logger。 */
interface WarnLogger {
  warn(object: unknown, message?: string): void;
}

/** 摘要要覆盖的三件事 —— 少了任何一件,压缩后的会话就"失忆"。 */
const SUMMARY_INSTRUCTIONS = [
  "You are compacting an agent conversation so it can continue with less context.",
  "Write a summary that preserves:",
  "1. What the user asked for and any constraints they stated;",
  "2. What was actually done — files changed, commands run, findings, with concrete names;",
  "3. What is still open — unfinished steps, unresolved questions, known failures.",
  "",
  "Be specific over brief: keep file paths, identifiers and error messages verbatim.",
  "Do not add commentary about the summary itself. Output plain text, no preamble."
].join("\n");

/** 单条工具输出最多铺 500 字进摘要输入 —— 否则摘要请求自己就超上下文了。 */
const MAX_PART_CHARS = 500;

const truncate = (text: string, max = MAX_PART_CHARS): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

const summarizeParts = (message: StoredMessage): string => {
  const chunks: string[] = [];

  for (const part of message.message.parts) {
    if (isTextPart(part)) {
      if (part.text.trim().length > 0) chunks.push(part.text);
      continue;
    }

    if (isDynamicToolPart(part)) {
      const input = JSON.stringify(part.input ?? {});
      const output = truncate(toolPartOutput(part));
      chunks.push(`tool ${part.toolName}(${input}) → ${output}`);
    }
  }

  return chunks.join("\n").trim();
};

/**
 * 用 tool 槽位模型生成压缩摘要(docs 14 §4.3)。
 * 抛错即代表"这次摘要没做成",由 compactSession 回落到确定性拼接。
 */
export const createModelSummarizer = (
  binding: ModelBinding,
  logger: WarnLogger
): SummarizeMessages => async (messages, previousSummary) => {
  const transcript = messages
    .map((m) => `[${m.role}] ${summarizeParts(m)}`)
    .join("\n\n");

  try {
    const { text } = await generateText({
      model: toAgentModel(binding),
      instructions: SUMMARY_INSTRUCTIONS,
      prompt: previousSummary
        ? `Previous summary:\n${previousSummary}\n\nNew messages to fold in:\n${transcript}`
        : transcript,
      maxOutputTokens: 1200,
      // 摘要要稳定可复现,不要发散。
      temperature: 0
    });

    return text;
  } catch (error) {
    logger.warn({ err: error, model: binding.qualifiedModelId }, "LLM 摘要失败,回落确定性拼接");
    throw error;
  }
};