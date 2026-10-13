import { describe, expect, it } from "vitest";

import type {
  AssistantMessage,
  CompactBoundaryMessage,
  ResultMessage,
  StreamEventMessage,
  SystemInitMessage,
  TurnCompleteMessage,
  UserMessage,
} from "../../../packages/harness/src/query/types.js";
import { toRunStreamFrames } from "../../../apps/server/src/modules/runs/harness-frames.js";

/** plan §3.5 映射表逐行验收:给定 HarnessMessage,产出的帧序列逐帧钉死。 */

const init: SystemInitMessage = {
  type: "system", subtype: "init",
  model: "openai:gpt-x", tools: ["read_file"], system_prompt: "You are Eva.",
  parent_tool_use_id: null,
};

const stepStart: StreamEventMessage = {
  type: "stream_event",
  event: { type: "step_start", turn: 0 },
  parent_tool_use_id: null,
};

const textDelta: StreamEventMessage = {
  type: "stream_event",
  event: { type: "text_delta", text: "hi" },
  parent_tool_use_id: null,
};

const reasoningDelta: StreamEventMessage = {
  type: "stream_event",
  event: { type: "reasoning_delta", text: "think" },
  parent_tool_use_id: null,
};

const toolInputStart: StreamEventMessage = {
  type: "stream_event",
  event: { type: "tool_input_start", tool_use_id: "tc-1", tool_name: "echo" },
  parent_tool_use_id: null,
};

const toolInputDelta: StreamEventMessage = {
  type: "stream_event",
  event: { type: "tool_input_delta", tool_use_id: "tc-1", delta: "{\"msg\"" },
  parent_tool_use_id: null,
};

const toolCallAssistant: AssistantMessage = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { msg: "hi" } },
    ],
  },
  turn: 0,
  parent_tool_use_id: null,
};

/** 文本块的 assistant:增量已由 stream_event 发过 → 无帧。 */
const textAssistant: AssistantMessage = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  turn: 0,
  parent_tool_use_id: null,
};

const turnComplete: TurnCompleteMessage = {
  type: "system", subtype: "turn_complete",
  turn: 0,
  usage: { input_tokens: 10, output_tokens: 5 },
  ttft_ms: 120, duration_ms: 300, stop_reason: "tool-calls",
  parent_tool_use_id: null,
};

const user: UserMessage = {
  type: "user",
  message: {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc-1",
        toolName: "echo",
        output: { type: "text", value: "out:hi" },
      },
      {
        type: "tool-result",
        toolCallId: "tc-2",
        toolName: "boom",
        output: { type: "text", value: "Error: kaput" },
      },
    ],
  },
  turn: 0,
  tool_timing: {
    "tc-1": { approval_wait_ms: 5, queue_wait_ms: 0, exec_ms: 12, aborted: false },
    "tc-2": { approval_wait_ms: 0, queue_wait_ms: 0, exec_ms: 8, aborted: false },
  },
  parent_tool_use_id: null,
};

const compactBoundary: CompactBoundaryMessage = {
  type: "system", subtype: "compact_boundary",
  trigger: "auto",
  pre_tokens: 100, post_tokens: 40, pre_messages: 20, post_messages: 8,
  parent_tool_use_id: null,
};

const successResult: ResultMessage = {
  type: "result", subtype: "success",
  result: "The answer is: 42",
  num_turns: 2, duration_ms: 900,
  usage: { input_tokens: 20, output_tokens: 10 },
  stop_reason: "stop",
  parent_tool_use_id: null,
};

const interruptedResult: ResultMessage = {
  type: "result", subtype: "interrupted",
  errors: ["aborted"],
  num_turns: 1, duration_ms: 400,
  usage: { input_tokens: 5, output_tokens: 0 },
  stop_reason: null,
  parent_tool_use_id: null,
};

const executionErrorResult: ResultMessage = {
  type: "result", subtype: "error_during_execution",
  errors: ["context length exceeded"],
  failure_layer: "context",
  num_turns: 1, duration_ms: 200,
  usage: { input_tokens: 3, output_tokens: 0 },
  stop_reason: null,
  parent_tool_use_id: null,
};

const maxTurnsResult: ResultMessage = {
  type: "result", subtype: "error_max_turns",
  errors: ["max steps reached"],
  num_turns: 5, duration_ms: 5000,
  usage: { input_tokens: 50, output_tokens: 30 },
  stop_reason: "tool-calls",
  parent_tool_use_id: null,
};

describe("toRunStreamFrames(plan §3.5 映射表)", () => {
  it("system/init、turn_complete、compact_boundary、文本 assistant → 无帧", () => {
    expect(toRunStreamFrames(init)).toEqual([]);
    expect(toRunStreamFrames(turnComplete)).toEqual([]);
    expect(toRunStreamFrames(compactBoundary)).toEqual([]);
    expect(toRunStreamFrames(textAssistant)).toEqual([]);
  });

  it("stream_event:step_start/text/reasoning/tool_input_* → 对应帧", () => {
    expect(toRunStreamFrames(stepStart)).toEqual([{ type: "step-start", step: 0 }]);
    expect(toRunStreamFrames(textDelta)).toEqual([{ type: "text-delta", textDelta: "hi" }]);
    expect(toRunStreamFrames(reasoningDelta)).toEqual([{ type: "reasoning-delta", textDelta: "think" }]);
    expect(toRunStreamFrames(toolInputStart)).toEqual([{
      type: "tool-input-start", toolCallId: "tc-1", toolName: "echo",
    }]);
    expect(toRunStreamFrames(toolInputDelta)).toEqual([{
      type: "tool-input-delta", toolCallId: "tc-1", delta: "{\"msg\"",
    }]);
  });

  it("tool-call 块的 assistant → tool-call 帧(带完整 input)", () => {
    expect(toRunStreamFrames(toolCallAssistant)).toEqual([{
      type: "tool-call",
      toolCallId: "tc-1",
      toolName: "echo",
      input: { msg: "hi" },
    }]);
  });

  it("user:每个 tool-result part 一帧;status 由 Error: 前缀判,计时取 tool_timing", () => {
    expect(toRunStreamFrames(user)).toEqual([
      {
        type: "tool-result",
        toolCallId: "tc-1",
        toolName: "echo",
        output: "out:hi",
        status: "success",
        toolExecMs: 12, approvalWaitMs: 5, queueWaitMs: 0,
      },
      {
        type: "tool-result",
        toolCallId: "tc-2",
        toolName: "boom",
        output: "Error: kaput",
        status: "error",
        toolExecMs: 8, approvalWaitMs: 0, queueWaitMs: 0,
      },
    ]);
  });

  it("result success → finish(stop,带 text/usage/durationMs)", () => {
    const [frame] = toRunStreamFrames(successResult);
    expect(frame).toMatchObject({
      type: "finish",
      text: "The answer is: 42",
      finishReason: "stop",
      durationMs: 900,
      usage: {
        inputTokens: 20, outputTokens: 10, totalTokens: 30,
      },
    });
  });

  it("result interrupted / error_max_turns → finish(aborted / max-steps)", () => {
    const [interrupted] = toRunStreamFrames(interruptedResult);
    expect(interrupted).toMatchObject({ type: "finish", finishReason: "aborted" });
    const [maxTurns] = toRunStreamFrames(maxTurnsResult);
    expect(maxTurns).toMatchObject({ type: "finish", finishReason: "max-steps" });
  });

  it("result error_during_execution → error 帧(带 failureLayer)+ finish(error)", () => {
    expect(toRunStreamFrames(executionErrorResult)).toEqual([
      { type: "error", message: "context length exceeded", failureLayer: "context" },
      expect.objectContaining({ type: "finish", finishReason: "error" }),
    ]);
  });
});
