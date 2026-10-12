import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { createAgent } from "../../../packages/harness/src/agents/agent.js";
import { textResult, tool } from "../../../packages/harness/src/tools/tool.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const response = (reason: "stop" | "length") => ({ stream: simulateReadableStream({ chunks: [
  { type: "stream-start", warnings: [] }, { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "partial" }, { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: reason, raw: reason }, usage },
] }) });

describe("runtime contracts", () => {
  it("length continuation retains the task, constraints, and previous output", async () => {
    const prompts: unknown[] = [];
    const agent = createAgent({ model: new MockLanguageModelV4({ doStream: async (o) => {
      prompts.push(o.prompt); return response(prompts.length === 1 ? "length" : "stop");
    } }), maxSteps: 5 });
    const events = [];
    for await (const event of agent.stream({ messages: [{ role: "user", content: "TASK: preserve constraints" }] })) events.push(event);
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain("TASK: preserve constraints");
    expect(JSON.stringify(prompts[1])).toContain("partial");
    expect(events.at(-1)).toMatchObject({ type: "finish", text: "partialpartial", finishReason: "stop" });
  });

  it("additional tools use the same approval policy as configured tools", async () => {
    const canUseTool = vi.fn(async () => ({ behavior: "deny" } as const));
    const execute = vi.fn(async () => textResult("mutated"));
    let calls = 0;
    const agent = createAgent({ canUseTool, maxSteps: 3, model: new MockLanguageModelV4({ doStream: async () => ++calls === 1 ? {
      stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "tc", toolName: "mutate", input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
      ] }),
    } : response("stop") }) });
    const extra = tool({ name: "mutate", description: "mutate", inputSchema: z.object({}), execute: execute });
    for await (const _ of agent.stream({ messages: [{ role: "user", content: "go" }], additionalTools: [extra] })) {}
    expect(execute).not.toHaveBeenCalled();
    expect(canUseTool).toHaveBeenCalledOnce();
  });

  it("tools cannot replace a configured tool by name", async () => {
    const sameName = tool({ name: "same", description: "same", inputSchema: z.object({}), execute: async () => textResult("ok") });
    const agent = createAgent({ tools: [sameName], model: new MockLanguageModelV4({ doStream: async () => response("stop") }) });
    const events = [];
    for await (const event of agent.stream({ messages: [{ role: "user", content: "go" }], additionalTools: [sameName] })) events.push(event);
    expect(events).toEqual([{ type: "error", message: "Duplicate tool name: same" }]);
  });

  it("compacts loaded session history on the first model step", async () => {
    const prompts: unknown[] = [];
    const telemetry: { type: string }[] = [];
    const agent = createAgent({
      model: new MockLanguageModelV4({
        doStream: async (options) => {
          prompts.push(options.prompt);
          return response("stop");
        },
      }),
      contextPolicy: {
        contextWindow: 100,
        reservedOutputTokens: 0,
        loopCompactBufferTokens: 10,
      },
      observer: (event) => telemetry.push(event),
    });
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: "user" as const,
      content: `history-${index}: ${"x".repeat(80)}`,
    }));

    for await (const _ of agent.stream({ messages })) {}

    expect(telemetry).toContainEqual(expect.objectContaining({
      type: "context_compacted",
      reason: "proactive_loop_compact",
    }));
    expect(JSON.stringify(prompts[0])).toContain("<context_summary>");
  });
});
