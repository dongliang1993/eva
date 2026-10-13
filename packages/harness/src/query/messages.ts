import type { ModelMessage } from "ai";

import type {
  AssistantMessage,
  CompactBoundaryMessage,
  HarnessMessage,
  ResultMessage,
  StreamDelta,
  StreamEventMessage,
  SystemInitMessage,
  TokenUsage,
  ToolTiming,
  TurnCompleteMessage,
  UserMessage,
} from "./types.js";

/**
 * HarnessMessage 的构造函数 —— 每种消息一个纯函数。
 *
 * 构造收敛在一个文件:判别字段(type/subtype)与 snake_case 字段名
 * 只在这里出现,turn.ts / query.ts 只挑构造器调。
 */

export const systemInitMessage = (input: {
  readonly model: string;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly parentToolUseID: string | null;
}): SystemInitMessage => ({
  type: "system",
  subtype: "init",
  model: input.model,
  tools: [...input.tools],
  system_prompt: input.systemPrompt,
  parent_tool_use_id: input.parentToolUseID,
});

export const streamEventMessage = (
  event: StreamDelta,
  parentToolUseID: string | null,
): StreamEventMessage => ({
  type: "stream_event",
  event,
  parent_tool_use_id: parentToolUseID,
});

export const assistantMessage = (input: {
  readonly message: Extract<ModelMessage, { role: "assistant" }>;
  readonly turn: number;
  readonly parentToolUseID: string | null;
}): AssistantMessage => ({
  type: "assistant",
  message: input.message,
  turn: input.turn,
  parent_tool_use_id: input.parentToolUseID,
});

export const turnCompleteMessage = (input: {
  readonly turn: number;
  readonly usage: TokenUsage;
  readonly ttftMs: number | null;
  readonly durationMs: number;
  readonly stopReason: string;
  readonly parentToolUseID: string | null;
}): TurnCompleteMessage => ({
  type: "system",
  subtype: "turn_complete",
  turn: input.turn,
  usage: input.usage,
  ttft_ms: input.ttftMs,
  duration_ms: input.durationMs,
  stop_reason: input.stopReason,
  parent_tool_use_id: input.parentToolUseID,
});

export const userMessage = (input: {
  readonly message: Extract<ModelMessage, { role: "tool" }>;
  readonly turn: number;
  readonly toolTiming: Readonly<Record<string, ToolTiming>>;
  readonly parentToolUseID: string | null;
}): UserMessage => ({
  type: "user",
  message: input.message,
  turn: input.turn,
  tool_timing: input.toolTiming,
  parent_tool_use_id: input.parentToolUseID,
});

export const compactBoundaryMessage = (input: {
  readonly trigger: "auto" | "overflow_retry";
  readonly preTokens: number;
  readonly postTokens: number;
  readonly preMessages: number;
  readonly postMessages: number;
  readonly parentToolUseID: string | null;
}): CompactBoundaryMessage => ({
  type: "system",
  subtype: "compact_boundary",
  trigger: input.trigger,
  pre_tokens: input.preTokens,
  post_tokens: input.postTokens,
  pre_messages: input.preMessages,
  post_messages: input.postMessages,
  parent_tool_use_id: input.parentToolUseID,
});

export const resultMessage = {
  success: (input: {
    readonly result: string;
    readonly numTurns: number;
    readonly durationMs: number;
    readonly usage: TokenUsage;
    readonly stopReason: string | null;
    readonly parentToolUseID: string | null;
  }): ResultMessage => ({
    type: "result",
    subtype: "success",
    result: input.result,
    num_turns: input.numTurns,
    duration_ms: input.durationMs,
    usage: input.usage,
    stop_reason: input.stopReason,
    parent_tool_use_id: input.parentToolUseID,
  }),
  failure: (input: {
    readonly subtype: "error_max_turns" | "error_during_execution" | "interrupted";
    readonly errors: readonly string[];
    readonly failureLayer?: "context" | "model";
    readonly numTurns: number;
    readonly durationMs: number;
    readonly usage: TokenUsage;
    readonly stopReason: string | null;
    readonly parentToolUseID: string | null;
  }): ResultMessage => ({
    type: "result",
    subtype: input.subtype,
    errors: [...input.errors],
    ...(input.failureLayer !== undefined ? { failure_layer: input.failureLayer } : {}),
    num_turns: input.numTurns,
    duration_ms: input.durationMs,
    usage: input.usage,
    stop_reason: input.stopReason,
    parent_tool_use_id: input.parentToolUseID,
  }),
};

/** tool-call 的 Map 计时 → UserMessage.tool_timing 的 record(键 = tool_use_id)。 */
export const toToolTimingRecord = (
  timings: ReadonlyMap<string, ToolTiming>,
): Readonly<Record<string, ToolTiming>> => {
  const record: Record<string, ToolTiming> = {};
  for (const [id, timing] of timings) {
    record[id] = timing;
  }
  return record;
};

export type { HarnessMessage };
