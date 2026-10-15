import { toRunStreamFrames } from "../../helpers/frames.js";
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { createRunLoopAgent } from "../../../packages/harness/src/agents/run-loop.js";
import { query } from "../../../packages/harness/src/query/query.js";
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
    const run = query({ prompt: [{ role: "user", content: "TASK: preserve constraints" }], options: {
      model: { languageModel: new MockLanguageModelV4({ doStream: async (o) => {
        prompts.push(o.prompt); return response(prompts.length === 1 ? "length" : "stop");
      } }), id: "mock:model" },
      maxTurns: 5,
    } });
    const events = [];
    for await (const message of run) {
      for (const event of toRunStreamFrames(message)) events.push(event);
    }
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain("TASK: preserve constraints");
    expect(JSON.stringify(prompts[1])).toContain("partial");
    expect(events.at(-1)).toMatchObject({ type: "finish", text: "partialpartial", finishReason: "stop" });
  });

  it("additional tools use the same approval policy as configured tools", async () => {
    const canUseTool = vi.fn(async () => ({ behavior: "deny" } as const));
    const execute = vi.fn(async () => textResult("mutated"));
    let calls = 0;
    const agent = createRunLoopAgent({ canUseTool, maxSteps: 3, model: new MockLanguageModelV4({ doStream: async () => ++calls === 1 ? {
      stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "tc", toolName: "mutate", input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
      ] }),
    } : response("stop") }) });
    const extra = tool({ name: "mutate", description: "mutate", inputSchema: z.object({}), execute: execute });
    for await (const message of agent.stream({ messages: [{ role: "user", content: "go" }], tools: [extra] })) {
      for (const _ of toRunStreamFrames(message)) {
      }
    }
    expect(execute).not.toHaveBeenCalled();
    expect(canUseTool).toHaveBeenCalledOnce();
  });

  it("tools cannot replace a configured tool by name", async () => {
    const sameName = tool({ name: "same", description: "same", inputSchema: z.object({}), execute: async () => textResult("ok") });
    const agent = createRunLoopAgent({ tools: [sameName], model: new MockLanguageModelV4({ doStream: async () => response("stop") }) });
    const events = [];
    for await (const message of agent.stream({ messages: [{ role: "user", content: "go" }], tools: [sameName] })) {
      for (const event of toRunStreamFrames(message)) events.push(event);
    }
    expect(events).toEqual([{ type: "error", message: "Duplicate tool name: same" }]);
  });

  it("compacts loaded session history on the first model step", async () => {
    const prompts: unknown[] = [];
    let calls = 0;
    // observer 的 context_compacted(proactive_loop_compact)已删:同一信息由
    // system/compact_boundary 消息(trigger="auto")承担;边界消息在下一圈开头产出,
    // 单步 run 收不到 —— 模型改两步(先工具后文本)让边界可观察。
    const echoTool = tool({ name: "echo", description: "echo", inputSchema: z.object({ msg: z.string() }), execute: async (input: { msg: string }) => textResult(input.msg) });
    const agent = createRunLoopAgent({
      model: new MockLanguageModelV4({
        doStream: async (options) => {
          prompts.push(options.prompt);
          calls += 1;
          if (calls === 1) {
            return { stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: "tc-1", toolName: "echo" },
              { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: JSON.stringify({ msg: "hi" }) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
            ] }) };
          }
          return response("stop");
        },
      }),
      tools: [echoTool],
      canUseTool: async () => ({ behavior: "allow" as const }),
      contextPolicy: {
        contextWindow: 100,
        reservedOutputTokens: 0,
        loopCompactBufferTokens: 10,
      },
    });
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: "user" as const,
      content: `history-${index}: ${"x".repeat(80)}`,
    }));
    const out = [];
    for await (const message of agent.stream({ messages })) {
      for (const event of toRunStreamFrames(message)) {
      }
      out.push(message);
    }

    const boundary = out.find(
      (m) => m.type === "system" && m.subtype === "compact_boundary",
    );
    expect(boundary).toMatchObject({ type: "system", subtype: "compact_boundary", trigger: "auto" });
    expect(JSON.stringify(prompts[0])).toContain("<context_summary>");
  });
});
