import type { FastifyBaseLogger } from "fastify";

import type { AgentTelemetryEvent } from "@eva/harness";

export interface ClampEvent {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly observedTokens: number;
}

export const createPinoObserver = (
  logger: FastifyBaseLogger,
  onClamp?: (event: ClampEvent) => void
): ((event: AgentTelemetryEvent) => void) => {
  return (event: AgentTelemetryEvent): void => {
    switch (event.type) {
      case "agent_run_start":
        logger.info({ event: "agent_run_start" }, "agent run started");
        break;
      case "agent_run_end":
        logger.info(
          {
            event: "agent_run_end",
            durationMs: event.totalDurationMs,
            steps: event.stepCount,
            tokens: event.totalTokenUsage,
            toolCalls: event.toolCallCount
          },
          "agent run completed"
        );
        break;
      case "llm_call_start":
        logger.debug(
          { event: "llm_call_start", step: event.step, model: event.model },
          "LLM call started"
        );
        break;
      case "llm_call_end":
        logger.info(
          {
            event: "llm_call_end",
            step: event.step,
            durationMs: event.durationMs,
            tokens: event.tokenUsage,
            hasToolCalls: event.hasToolCalls
          },
          "LLM call completed"
        );
        break;
      case "loop_transition":
        logger.info(
          {
            event: "loop_transition",
            step: event.step,
            reason: event.reason,
            ...(event.attempt !== undefined ? { attempt: event.attempt } : {})
          },
          `agent loop transitioned via ${event.reason}`
        );
        break;
      case "context_compacted":
        logger.info(
          {
            event: "context_compacted",
            step: event.step,
            reason: event.reason,
            messageCountBefore: event.messageCountBefore,
            messageCountAfter: event.messageCountAfter,
            estimatedTokensBefore: event.estimatedTokensBefore,
            estimatedTokensAfter: event.estimatedTokensAfter
          },
          `agent context compacted via ${event.reason}`
        );
        break;
      case "context_overflow_clamp":
        // T38: 模型真实超限 → 钳小它的 contextWindow(写 DB),下次 resolve 生效。
        logger.warn(
          {
            event: "context_overflow_clamp",
            model: event.modelId,
            contextWindow: event.contextWindow,
            observedTokens: event.observedTokens
          },
          `[AutoCompact] ${event.modelId} rejected ${event.observedTokens} tokens — clamping contextWindow`
        );
        onClamp?.({
          providerId: event.providerId,
          modelId: event.modelId,
          contextWindow: event.contextWindow,
          observedTokens: event.observedTokens
        });
        break;
      case "tool_count_degraded":
        // T43: 工具数超限进 discovery mode —— 必须可见,否则「配的 MCP 工具没直接出现」无从排查。
        logger.warn(
          {
            event: "tool_count_degraded",
            totalCount: event.totalCount,
            keptCount: event.keptCount,
            limit: event.limit
          },
          `[ToolSafetyNet] ${event.totalCount} tools > ${event.limit} — discovery mode (${event.keptCount} core tools active; use tool_search to activate more)`
        );
        break;
    }
  };
};
