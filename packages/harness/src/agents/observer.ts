import type { StreamTokenUsage } from "@eva/shared";

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** T40:命中 prompt cache 的 input tokens(SDK inputTokenDetails.cacheReadTokens)。非 cache 模型留 undefined。 */
  readonly cachedInputTokens?: number;
  /** T40:写入 prompt cache 的 input tokens(SDK inputTokenDetails.cacheWriteTokens)。 */
  readonly cacheWriteTokens?: number;
  /** T40:o1/Claude thinking 的 reasoning tokens(SDK outputTokenDetails.reasoningTokens)。 */
  readonly reasoningTokens?: number;
}

export type LoopTransitionReason =
  | "next_turn"
  | "proactive_loop_compact"
  | "reactive_compact_retry"
  | "max_output_tokens_recovery"
  /** S7:后台子代理交付结论 → 注入通知后续跑一圈。 */
  | "subagent_notice"
  /** T22:步数撞顶终态 —— 异常必须留痕(排查"agent 为什么停了"靠它)。 */
  | "max_steps";

export type ContextCompactionReason =
  | "proactive_loop_compact"
  | "reactive_compact_retry";

const readStringField = (
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined => {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
};

export type AgentTelemetryEvent =
  | { readonly type: "agent_run_start" }
  | {
      readonly type: "agent_run_end";
      readonly totalDurationMs: number;
      readonly stepCount: number;
      readonly totalTokenUsage: TokenUsage;
      readonly toolCallCount: number;
    }
  | {
      readonly type: "llm_call_start";
      readonly step: number;
      readonly model?: string;
    }
  | {
      readonly type: "llm_call_end";
      readonly step: number;
      readonly durationMs: number;
      readonly tokenUsage?: TokenUsage;
      readonly hasToolCalls: boolean;
    }
  | {
      readonly type: "tool_call_initiated";
      readonly step: number;
      readonly toolName: string;
      readonly toolCallId: string;
    }
  | {
      readonly type: "tool_call_completed";
      readonly step: number;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly status: "success" | "error";
      readonly durationMs: number;
    }
  | {
      /** T18:repairToolCall 修复成功(失败不发 —— 那会有 error 事件收尾)。 */
      readonly type: "tool_call_repaired";
      readonly toolName: string;
      /** name=工具名修成真实存在的;input=入参按 schema 重出。 */
      readonly kind: "name" | "input";
    }
  | {
      readonly type: "loop_transition";
      readonly step: number;
      readonly reason: LoopTransitionReason;
      readonly attempt?: number;
    }
  | {
      readonly type: "context_compacted";
      readonly step: number;
      readonly reason: ContextCompactionReason;
      readonly messageCountBefore: number;
      readonly messageCountAfter: number;
      readonly estimatedTokensBefore: number;
      readonly estimatedTokensAfter: number;
    }
  | {
      /**
       * T38: 模型真实报 context 超限(reactive compact 路径触发)——server 侧订阅此事件
       * 把该模型的 contextWindow 永久钳小写 DB(Alma main:90647 clamping 学习)。
       * observedTokens = 触发时估算/真实的用量,作为「实际能跑多少」的钳制参考。
       */
      readonly type: "context_overflow_clamp";
      readonly providerId: string;
      readonly modelId: string;
      readonly contextWindow: number;
      readonly observedTokens: number;
    }
  | {
      /**
       * T39/T43: 工具数超限且未显式设 activeTools → 进 discovery mode(Alma PM-011)。
       * keptCount 是首步 active 的核心工具数,不是「剩余全部工具数」;其余工具
       * 由 tool_search 激活。server observer 收到打 warning —— 静默退化会让
       * 「配的 MCP 工具没直接出现」无从排查。
       */
      readonly type: "tool_count_degraded";
      readonly totalCount: number;
      readonly keptCount: number;
      readonly limit: number;
    };

export type AgentObserver = (event: AgentTelemetryEvent) => void;

export const ZERO_TOKEN_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0
};

export const addTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => {
  // 可选明细字段:两边都有才相加,单边有就保留,全无 → undefined(不落 0,语义干净)。
  const opt = (
    x: number | undefined,
    y: number | undefined
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
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {})
  };
};

/**
 * 从 SDK LanguageModelUsage 读 TokenUsage。SDK v7 已把 cache/reasoning 归一进
 * inputTokenDetails/outputTokenDetails(ai@7.0.64)——这里读归一出口,跨 provider
 * 免费,不抠 Anthropic 私货 cacheCreationInputTokens。
 * 明细缺失 → undefined(不写 0),由落库层 ?? 0。
 */
export const readTokenUsage = (
  u:
    | {
        inputTokens: number | undefined;
        outputTokens: number | undefined;
        totalTokens: number | undefined;
        inputTokenDetails?: {
          noCacheTokens?: number | undefined;
          cacheReadTokens?: number | undefined;
          cacheWriteTokens?: number | undefined;
        };
        outputTokenDetails?: {
          textTokens?: number | undefined;
          reasoningTokens?: number | undefined;
        };
      }
    | undefined
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
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {})
  };
};

/** TokenUsage → SSE finish 帧的 StreamTokenUsage(蛇形 → 驼峰直透,明细缺则省键)。 */
export const toStreamTokenUsage = (u: TokenUsage): StreamTokenUsage => ({
  inputTokens: u.promptTokens,
  outputTokens: u.completionTokens,
  totalTokens: u.totalTokens,
  ...(u.cachedInputTokens !== undefined
    ? { cachedInputTokens: u.cachedInputTokens }
    : {}),
  ...(u.cacheWriteTokens !== undefined
    ? { cacheWriteTokens: u.cacheWriteTokens }
    : {}),
  ...(u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {})
});

export const extractTokenUsage = (
  responseMetadata: Record<string, unknown> | undefined
): TokenUsage | undefined => {
  const usage = responseMetadata?.usage;

  if (typeof usage !== "object" || usage === null || !("prompt_tokens" in usage)) {
    return undefined;
  }

  const u = usage as Record<string, unknown>;

  return {
    promptTokens: Number(u.prompt_tokens) || 0,
    completionTokens: Number(u.completion_tokens) || 0,
    totalTokens: Number(u.total_tokens) || 0
  };
};

export const extractFinishReason = (
  responseMetadata: Record<string, unknown> | undefined
): string | undefined =>
  readStringField(responseMetadata, "finish_reason")
  ?? readStringField(responseMetadata, "finishReason")
  ?? readStringField(responseMetadata, "stop_reason")
  ?? readStringField(responseMetadata, "stopReason");

export const isMaxOutputContinuationCandidate = (
  responseMetadata: Record<string, unknown> | undefined
): boolean => {
  const finishReason = extractFinishReason(responseMetadata)?.toLowerCase();

  return finishReason === "length"
    || finishReason === "max_tokens"
    || finishReason === "max_output_tokens";
};
