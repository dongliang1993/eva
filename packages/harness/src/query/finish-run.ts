/** max-steps 的收尾文案(与 result 消息同源)。 */
export const resolveFinalText = (
  accumulated: string,
  finishReason: "stop" | "aborted" | "error" | "max-steps",
  maxSteps: number,
): string =>
  finishReason === "max-steps"
    ? `The agent reached the maximum tool-calling steps (${maxSteps}) without producing a final answer. ` +
      "The work so far is preserved in this conversation — ask me to continue and I'll pick up where I left off."
    : accumulated.trim() || "The model returned an empty response.";

export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";
