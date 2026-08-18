import type { EvaUIMessage } from "@eva/shared";
import { isDynamicToolPart, isTextPart, toolPartOutput } from "@eva/shared";

import type { ModelHistory } from "./session.js";

/**
 * Lightweight token estimation without external dependencies.
 *
 * Heuristics:
 *  - English / Latin text: ~4 characters per token
 *  - CJK text (Chinese / Japanese / Korean): ~2 characters per token
 *  - Each message has ~4 tokens of framing overhead
 */

/** Rough token count for a single string. */
export const estimateTokens = (text: string): number => {
  let cjkChars = 0;

  for (const char of text) {
    if (char.charCodeAt(0) > 0x2e80) cjkChars++;
  }

  const nonCjk = text.length - cjkChars;

  return Math.ceil(nonCjk / 4 + cjkChars / 2);
};

export const MESSAGE_OVERHEAD_TOKENS = 4;

/** Estimate total tokens for a list of legacy { content: string } history. */
export const estimateHistoryTokens = (
  messages: readonly { content: string }[]
): number => {
  let total = 0;

  for (const m of messages) {
    total += estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS;
  }

  return total;
};

/**
 * 单条 UIMessage 的 token 估算。
 * 工具入参与输出必须计入 —— T1 之前它们被历史构建整个丢掉了,
 * 所以旧的估算值系统性偏低,auto-compact 的阈值实际上从来没准过。
 */
export const estimateUiMessageTokens = (message: EvaUIMessage): number => {
  let total = MESSAGE_OVERHEAD_TOKENS;

  for (const part of message.parts) {
    if (isTextPart(part)) {
      total += estimateTokens(part.text);
      continue;
    }

    if (isDynamicToolPart(part)) {
      total += estimateTokens(JSON.stringify(part.input ?? {}));
      total += estimateTokens(toolPartOutput(part));
    }
  }

  return total;
};

export const estimateModelHistoryTokens = (history: ModelHistory): number => {
  const summaryTokens = history.summary
    ? estimateTokens(history.summary) + MESSAGE_OVERHEAD_TOKENS
    : 0;

  return history.messages.reduce(
    (sum, message) => sum + estimateUiMessageTokens(message),
    summaryTokens
  );
};