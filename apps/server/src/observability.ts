import type { FastifyBaseLogger } from "fastify";

import type { AgentTelemetryEvent } from "@eva/harness";

export const createPinoObserver = (
  logger: FastifyBaseLogger
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
    }
  };
};
