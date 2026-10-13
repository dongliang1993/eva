import type { TokenUsage as ContractTokenUsage } from "./types.js";

/**
 * run 内部的用量统计(SDK LanguageModelUsage → 累加 → 契约 TokenUsage)。
 *
 * 契约的 snake_case TokenUsage 是对外形状(toContractTokenUsage);
 * 这里保持 AI SDK 邻接的驼峰形状,run-loop 逐步累加后一次转换。
 */

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** 命中 prompt cache 的 input tokens(SDK inputTokenDetails.cacheReadTokens)。非 cache 模型留 undefined。 */
  readonly cachedInputTokens?: number;
  /** 写入 prompt cache 的 input tokens(inputTokenDetails.cacheWriteTokens)。 */
  readonly cacheWriteTokens?: number;
  /** thinking 模型的 reasoning tokens(outputTokenDetails.reasoningTokens)。 */
  readonly reasoningTokens?: number;
}

export const ZERO_TOKEN_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

export const addTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => {
  // 可选明细字段:两边都有才相加,单边有就保留,全无 → undefined(不落 0,语义干净)。
  const opt = (
    x: number | undefined,
    y: number | undefined,
  ): number | undefined => (x === undefined ? y : y === undefined ? x : x + y);
  const cachedInputTokens = opt(a.cachedInputTokens, b.cachedInputTokens);
  const cacheWriteTokens = opt(a.cacheWriteTokens, b.cacheWriteTokens);
  const reasoningTokens = opt(a.reasoningTokens, b.reasoningTokens);
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
};

/**
 * 从 SDK LanguageModelUsage 读 TokenUsage。SDK v7 已把 cache/reasoning 归一进
 * inputTokenDetails/outputTokenDetails —— 这里读归一出口,跨 provider 免费。
 * 明细缺失 → undefined(不写 0),由落库层 ?? 0。
 */
export const readTokenUsage = (
  u:
    | {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
      totalTokens: number | undefined;
      inputTokenDetails?: {
        cacheReadTokens?: number | undefined;
        cacheWriteTokens?: number | undefined;
      };
      outputTokenDetails?: {
        reasoningTokens?: number | undefined;
      };
    }
    | undefined,
): TokenUsage | undefined => {
  if (!u) return undefined;
  const promptTokens = u.inputTokens ?? 0;
  const completionTokens = u.outputTokens ?? 0;
  const totalTokens = u.totalTokens ?? promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0)
    return undefined;
  const cachedInputTokens = u.inputTokenDetails?.cacheReadTokens ?? undefined;
  const cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? undefined;
  const reasoningTokens = u.outputTokenDetails?.reasoningTokens ?? undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
};

/** 内部用量 → 契约 TokenUsage(snake_case,字段名照 SDK)。 */
export const toContractTokenUsage = (
  usage: TokenUsage,
): ContractTokenUsage => ({
  input_tokens: usage.promptTokens,
  output_tokens: usage.completionTokens,
  ...(usage.cachedInputTokens !== undefined
    ? { cache_read_input_tokens: usage.cachedInputTokens }
    : {}),
  ...(usage.cacheWriteTokens !== undefined
    ? { cache_creation_input_tokens: usage.cacheWriteTokens }
    : {}),
  ...(usage.reasoningTokens !== undefined
    ? { reasoning_tokens: usage.reasoningTokens }
    : {}),
});
