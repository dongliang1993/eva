import type { FinishReason as ModelFinishReason, ModelMessage } from "ai";
import type { RunInjectedNotice } from "@eva/shared";

import type { ContextWindowPolicy } from "../context/policy.js";
import {
  applyReactiveLoopCompactWithStats,
  type RuntimeCompactResult,
} from "../context/runtime-compact.js";
import { isReactiveCompactCandidateError } from "../models/errors.js";
import {
  MAX_OUTPUT_CONTINUATION_MESSAGE,
  shouldContinueForMaxOutput,
} from "./context-strategy.js";

export const NOTICE_GRACE_MS = 20_000;
export const MAX_NOTICE_ROUNDS = 4;

export interface ReactiveRecoveryPlan {
  readonly errorMessage: string;
  readonly compactCandidate: boolean;
  readonly compaction?: RuntimeCompactResult;
}

/** Reactive compact 最多成功一次；是否钳制模型登记值由 run loop 根据本计划观测。 */
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

export const canDrainNotices = (input: {
  readonly stepsUsed: number;
  readonly maxSteps: number;
  readonly noticeRounds: number;
  readonly hasDrainNotices: boolean;
}): boolean =>
  input.stepsUsed < input.maxSteps &&
  input.hasDrainNotices &&
  input.noticeRounds < MAX_NOTICE_ROUNDS;

export const buildNoticeRecovery = (input: {
  readonly responseMessages: readonly ModelMessage[];
  readonly notices: readonly RunInjectedNotice[];
  readonly noticeRounds: number;
}): { readonly messages: ModelMessage[]; readonly noticeRounds: number } => ({
  messages: [
    ...input.responseMessages,
    {
      role: "user",
      content: input.notices.map((notice) => notice.text).join("\n\n"),
    },
  ],
  noticeRounds: input.noticeRounds + 1,
});
