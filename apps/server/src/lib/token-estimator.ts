import type { EvaUIMessage } from "@eva/shared";
import { isDynamicToolPart, isTextPart, toolPartOutput } from "@eva/shared";

import type { ModelHistory } from "../modules/sessions/index.js";

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
    summaryTokens,
  );
};
