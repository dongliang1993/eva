import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { createAgent } from "../packages/harness/src/agents/create-agent.js";
import type { AgentStreamEvent } from "../packages/harness/src/agents/types.js";

type FinishEvent = Extract<AgentStreamEvent, { type: "finish" }>;

const isFinish = (event: AgentStreamEvent): event is FinishEvent =>
  event.type === "finish";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

const slowStreamModel = (chunkDelayInMs: number): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "Hello" },
          { type: "text-delta", id: "1", delta: " world" },
          { type: "text-delta", id: "1", delta: " again" },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: "stop", usage }
        ],
        chunkDelayInMs
      })
    })
  });

describe("LeadAgent stream protocol + abort", () => {
  it("completes normally: emits step-start, text deltas, and finish(stop) with full text", async () => {
    const agent = createAgent({ model: slowStreamModel(5) });
    const events: AgentStreamEvent[] = [];

    for await (const event of agent.stream({
      messages: [{ role: "user", content: "hi" }]
    })) {
      events.push(event);
    }

    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.finishReason).toBe("stop");
    expect(finishes[0]?.text).toBe("Hello world again");

    expect(events.some((e) => e.type === "step-start")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);

    const streamedText = events
      .filter((e) => e.type === "text-delta")
      .map((e) => (e.type === "text-delta" ? e.textDelta : ""))
      .join("");
    expect(streamedText).toBe("Hello world again");
  });

  it("abort mid-run: yields finish(aborted) with partial text and no error event", async () => {
    const controller = new AbortController();
    const agent = createAgent({ model: slowStreamModel(60) });
    const events: AgentStreamEvent[] = [];

    for await (const event of agent.stream({
      messages: [{ role: "user", content: "hi" }],
      abortSignal: controller.signal
    })) {
      events.push(event);
      if (event.type === "text-delta" && !controller.signal.aborted) {
        controller.abort();
      }
    }

    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.finishReason).toBe("aborted");
    expect(finishes[0]?.text).toContain("Hello");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
