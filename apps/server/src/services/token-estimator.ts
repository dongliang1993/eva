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

const MESSAGE_OVERHEAD_TOKENS = 4;

/** Estimate total tokens for a list of history messages. */
export const estimateHistoryTokens = (
  messages: readonly { content: string }[]
): number => {
  let total = 0;

  for (const m of messages) {
    total += estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS;
  }

  return total;
};
