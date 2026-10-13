import type { FinishReason as ModelFinishReason, ModelMessage } from "ai";

import type { ContextWindowPolicy } from "./policy.js";
import {
  applyReactiveLoopCompactWithStats,
  type RuntimeCompactResult,
} from "./runtime-compact.js";
import { isReactiveCompactCandidateError } from "../models/errors.js";
import {
  MAX_OUTPUT_CONTINUATION_MESSAGE,
  shouldContinueForMaxOutput,
} from "./context-strategy.js";


export interface ReactiveRecoveryPlan {
  readonly errorMessage: string;
  readonly compactCandidate: boolean;
  readonly compaction?: RuntimeCompactResult;
}

/** Reactive compact 最多成功一次；候选错误同时作为诊断事件记录。 */
export const planReactiveRecovery = (input: {
  readonly error: unknown;
  readonly messages: readonly ModelMessage[];
  readonly prefixMessageCount: number;
  readonly hasCompactedReactively: boolean;
}): ReactiveRecoveryPlan => {
  const errorMessage =
    input.error instanceof Error ? input.error.message : "Unknown error";
  const compactCandidate = isReactiveCompactCandidateError(input.error);
  if (input.hasCompactedReactively || !compactCandidate) {
    return { errorMessage, compactCandidate };
  }
  const compaction = applyReactiveLoopCompactWithStats(
    input.messages,
    input.prefixMessageCount,
  );
  return compaction.changed
    ? { errorMessage, compactCandidate, compaction }
    : { errorMessage, compactCandidate };
};

export const shouldRecoverMaxOutput = (input: {
  readonly finishReason: ModelFinishReason;
  readonly recoveries: number;
  readonly policy: ContextWindowPolicy;
}): boolean =>
  shouldContinueForMaxOutput(
    input.finishReason,
    input.recoveries,
    input.policy,
  );

export const buildMaxOutputRecovery = (input: {
  readonly responseMessages: readonly ModelMessage[];
  readonly continuedText: string;
  readonly text: string;
  readonly recoveries: number;
}): {
  readonly messages: ModelMessage[];
  readonly continuedText: string;
  readonly recoveries: number;
} => ({
  messages: [
    ...input.responseMessages,
    { role: "user", content: MAX_OUTPUT_CONTINUATION_MESSAGE },
  ],
  continuedText: input.continuedText + input.text,
  recoveries: input.recoveries + 1,
});
