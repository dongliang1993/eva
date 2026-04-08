export interface ContextWindowPolicy {
  readonly contextWindow: number;
  readonly reservedOutputTokens: number;
  readonly loopCompactBufferTokens: number;
  readonly blockingBufferTokens: number;
  readonly toolResultBudgetTokens: number;
  readonly maxOutputRecoveryLimit: number;
}

export interface ContextWindowPolicyOptions {
  readonly contextWindow?: number;
  readonly reservedOutputTokens?: number;
  readonly loopCompactBufferTokens?: number;
  readonly blockingBufferTokens?: number;
  readonly toolResultBudgetTokens?: number;
  readonly maxOutputRecoveryLimit?: number;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_000;
const DEFAULT_LOOP_COMPACT_BUFFER_TOKENS = 12_000;
const DEFAULT_BLOCKING_BUFFER_TOKENS = 4_000;
const DEFAULT_MAX_OUTPUT_RECOVERY_LIMIT = 3;
const DEFAULT_TOOL_RESULT_BUDGET_TOKENS = 12_000;
const MAX_TOOL_RESULT_BUDGET_TOKENS = 24_000;
const MIN_TOOL_RESULT_BUDGET_TOKENS = 1_000;

export const resolveContextWindowPolicy = (
  options: ContextWindowPolicyOptions | undefined
): ContextWindowPolicy => {
  const contextWindow = Math.max(
    1,
    options?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  );
  const reservedOutputTokens = Math.max(
    0,
    Math.min(
      options?.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
      contextWindow
    )
  );
  const remainingInputBudget = Math.max(0, contextWindow - reservedOutputTokens);
  const derivedToolResultBudget = Math.max(
    MIN_TOOL_RESULT_BUDGET_TOKENS,
    Math.min(
      DEFAULT_TOOL_RESULT_BUDGET_TOKENS,
      MAX_TOOL_RESULT_BUDGET_TOKENS,
      Math.floor(remainingInputBudget * 0.12)
    )
  );

  return {
    contextWindow,
    reservedOutputTokens,
    loopCompactBufferTokens: Math.max(
      0,
      options?.loopCompactBufferTokens ?? DEFAULT_LOOP_COMPACT_BUFFER_TOKENS
    ),
    blockingBufferTokens: Math.max(
      0,
      options?.blockingBufferTokens ?? DEFAULT_BLOCKING_BUFFER_TOKENS
    ),
    toolResultBudgetTokens: Math.max(
      0,
      options?.toolResultBudgetTokens ?? derivedToolResultBudget
    ),
    maxOutputRecoveryLimit: Math.max(
      0,
      options?.maxOutputRecoveryLimit ?? DEFAULT_MAX_OUTPUT_RECOVERY_LIMIT
    )
  };
};
