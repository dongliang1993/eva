import type { StreamToolCallSummary } from "@eva/shared";

import { TOOL_CALL_ABORTED_OUTPUT } from "../tools/build-tool.js";
import { toStreamTokenUsage, type AgentObserver, type TokenUsage } from "./observer.js";
import type { ToolCallClock } from "./stream-part-mapper.js";
import type { AgentStreamEvent, AgentToolCallResult } from "./types.js";

export type FinishReason = "stop" | "aborted" | "error" | "max-steps";

const toStreamToolCallSummary = (
  toolCall: AgentToolCallResult,
): StreamToolCallSummary => ({
  toolName: toolCall.toolName,
  toolCallId: toolCall.toolCallId ?? "",
  args: toolCall.args,
  output: toolCall.output,
  status: toolCall.status,
  ...(toolCall.durationMs !== undefined
    ? { durationMs: toolCall.durationMs }
    : {}),
});

export const resolveFinalText = (
  accumulated: string,
  finishReason: FinishReason,
  maxSteps: number,
): string =>
  finishReason === "max-steps"
    ? `The agent reached the maximum tool-calling steps (${maxSteps}) without producing a final answer. ` +
      "The work so far is preserved in this conversation — ask me to continue and I'll pick up where I left off."
    : accumulated.trim() || "The model returned an empty response.";

export interface FinishRunInput {
  readonly text: string;
  readonly toolCalls: readonly AgentToolCallResult[];
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
  readonly runStart: number;
  readonly stepsUsed: number;
  readonly maxSteps: number;
  readonly turn: { readonly index: number; readonly startTime: number };
  readonly emit: AgentObserver;
}

/** 生成终态帧，并保持 assistant → turn → run 的台账事件顺序。 */
export const finishRun = (
  input: FinishRunInput,
): Extract<AgentStreamEvent, { type: "finish" }> => {
  const resolvedText = resolveFinalText(
    input.text,
    input.finishReason,
    input.maxSteps,
  );
  input.emit({
    type: "assistant_message",
    text: resolvedText,
    toolCallCount: input.toolCalls.length,
  });
  input.emit({
    type: "turn_completed",
    turnIndex: input.turn.index,
    durationMs: Date.now() - input.turn.startTime,
    status: input.finishReason === "aborted" ? "aborted" : "completed",
  });
  input.emit({
    type: "agent_run_end",
    totalDurationMs: Date.now() - input.runStart,
    stepCount: input.stepsUsed,
    totalTokenUsage: input.usage,
    toolCallCount: input.toolCalls.length,
    ...(input.finishReason === "max-steps"
      ? { failureLayer: "orchestration" as const }
      : {}),
  });

  return {
    type: "finish",
    text: resolvedText,
    toolCalls: input.toolCalls.map(toStreamToolCallSummary),
    finishReason: input.finishReason,
    ...(input.usage.totalTokens > 0
      ? { usage: toStreamTokenUsage(input.usage) }
      : {}),
    durationMs: Date.now() - input.runStart,
  };
};

export interface AbortInFlightInput {
  readonly clock: ToolCallClock;
  readonly toolCalls: AgentToolCallResult[];
  readonly step: number;
  readonly emit: AgentObserver;
}

/** 把已发出 tool-call、尚未收到 tool-result 的调用确定性收口。 */
export function* abortInFlightToolCalls(
  input: AbortInFlightInput,
): Generator<Extract<AgentStreamEvent, { type: "tool-result" }>> {
  for (const [toolCallId, inFlight] of input.clock) {
    input.clock.delete(toolCallId);
    const durationMs = Date.now() - inFlight.startedAt;
    const canceled: AgentToolCallResult = {
      toolName: inFlight.toolName,
      toolCallId,
      args: {},
      output: TOOL_CALL_ABORTED_OUTPUT,
      status: "error",
      durationMs,
    };
    input.toolCalls.push(canceled);
    input.emit({
      type: "tool_call_abandoned",
      step: input.step,
      toolName: inFlight.toolName,
      toolCallId,
      waitedMs: durationMs,
    });
    yield {
      type: "tool-result",
      toolCallId,
      toolName: inFlight.toolName,
      output: TOOL_CALL_ABORTED_OUTPUT,
      status: "error",
      durationMs,
    };
  }
}

export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";
