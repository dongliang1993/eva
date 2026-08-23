export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
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
       * T39: 工具数超限且未显式设 activeTools → 退化最小集(Alma PM-011)。
       * server observer 收到打 warning —— 静默退化会让「配的 MCP 工具没生效」无从排查。
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

export const addTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  totalTokens: a.totalTokens + b.totalTokens
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
