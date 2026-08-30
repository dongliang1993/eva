import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abortInFlightToolCalls,
  finishRun,
} from "../../../packages/harness/src/agents/finish-run.js";
import { ZERO_TOKEN_USAGE, type AgentTelemetryEvent } from "../../../packages/harness/src/agents/observer.js";
import type { AgentToolCallResult } from "../../../packages/harness/src/agents/types.js";

afterEach(() => vi.useRealTimers());

describe("Agent finish and abort", () => {
  it("终态台账严格按 assistant_message → turn_completed → agent_run_end 发出", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const telemetry: AgentTelemetryEvent[] = [];

    const finish = finishRun({
      text: "done",
      toolCalls: [],
      finishReason: "stop",
      usage: ZERO_TOKEN_USAGE,
      runStart: 1_000,
      stepsUsed: 2,
      maxSteps: 5,
      turn: { index: 0, startTime: 2_000 },
      emit: (event) => telemetry.push(event),
    });

    expect(telemetry.map((event) => event.type)).toEqual([
      "assistant_message",
      "turn_completed",
      "agent_run_end",
    ]);
    expect(finish).toMatchObject({
      type: "finish",
      text: "done",
      finishReason: "stop",
      durationMs: 4_000,
    });
  });

  it("中止时逐个补齐在飞工具结果，并同步清空 clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const telemetry: AgentTelemetryEvent[] = [];
    const toolCalls: AgentToolCallResult[] = [];
    const clock = new Map([
      ["call-1", { toolName: "bash", startedAt: 4_000 }],
    ]);

    const events = [...abortInFlightToolCalls({
      clock,
      toolCalls,
      step: 3,
      emit: (event) => telemetry.push(event),
    })];

    expect(clock.size).toBe(0);
    expect(toolCalls).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "bash",
      status: "error",
      durationMs: 1_000,
    });
    expect(telemetry[0]).toMatchObject({
      type: "tool_call_abandoned",
      toolCallId: "call-1",
      waitedMs: 1_000,
    });
  });
});
