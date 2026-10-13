import type { FastifyBaseLogger } from "fastify";

import type { HarnessMessage } from "@eva/harness";

/**
 * HarnessMessage → pino 日志(第二订阅者)。
 *
 * 只留有诊断价值的行:压缩、失败、终态。逐 token 的增量不进日志 ——
 * 那是 SSE 与轨迹页的事。ledger 写挂了 Pino 照常,反之亦然。
 */
export const createPinoObserver = (
  logger: FastifyBaseLogger,
): ((message: HarnessMessage) => void) => {
  return (message: HarnessMessage): void => {
    if (message.type === "system" && message.subtype === "compact_boundary") {
      logger.info(
        {
          event: "context_compacted",
          trigger: message.trigger,
          messageCountBefore: message.pre_messages,
          messageCountAfter: message.post_messages,
          estimatedTokensBefore: message.pre_tokens,
          estimatedTokensAfter: message.post_tokens,
        },
        `agent context compacted via ${message.trigger === "auto" ? "proactive_loop_compact" : "reactive_compact_retry"}`
      );
      return;
    }

    if (message.type !== "result") return;

    switch (message.subtype) {
      case "success":
        logger.info(
          {
            event: "agent_run_end",
            durationMs: message.duration_ms,
            steps: message.num_turns,
            tokens: message.usage,
          },
          "agent run completed"
        );
        break;
      case "interrupted":
        logger.info(
          { event: "agent_run_end", durationMs: message.duration_ms, aborted: true },
          "agent run aborted"
        );
        break;
      case "error_max_turns":
        logger.warn(
          {
            event: "agent_run_end",
            durationMs: message.duration_ms,
            steps: message.num_turns,
          },
          "agent run ended at max steps"
        );
        break;
      case "error_during_execution": {
        const [firstError] = message.errors;
        logger.error(
          {
            event: "agent_run_failed",
            failureLayer: message.failure_layer,
            error: firstError ?? "Unknown error",
          },
          "agent run failed"
        );
        break;
      }
    }
  };
};
