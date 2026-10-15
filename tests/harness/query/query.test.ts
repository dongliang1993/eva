import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { query } from "../../../packages/harness/src/query/query.js";
import { textResult, tool } from "../../../packages/harness/src/tools/tool.js";
import { toRunStreamFrames } from "../../helpers/frames.js";
import type { HarnessMessage, Options } from "../../../packages/harness/src/query/types.js";
import type { RunStreamEvent } from "@eva/shared";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const modelOf = (chunks: readonly unknown[]) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: chunks as never,
      }),
    }),
  });

const baseOptions = (model: MockLanguageModelV4): Options => ({
  model: { languageModel: model as never, id: "openai:gpt-test" },
  includePartialMessages: true,
  canUseTool: async () => ({ behavior: "allow" as const }),
});

describe("query()", () => {
  it("顺序保证:system/init 先于一切,最后一条恒为 result(success)", async () => {
    const q = query({
      prompt: [{ role: "user", content: "hi" }],
      options: baseOptions(modelOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "done" },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ])),
    });

    const messages: HarnessMessage[] = [];
    for await (const message of q) messages.push(message);

    expect(messages[0]).toMatchObject({ type: "system", subtype: "init", model: "openai:gpt-test" });
    expect(messages.at(-1)).toMatchObject({ type: "result", subtype: "success", result: "done" });
  });

  it("工具名重复 → 同步抛(不进第一帧)", () => {
    const dup = tool({
      name: "same", description: "d", inputSchema: z.object({}),
      execute: async () => textResult("x"),
    });
    expect(() => query({
      prompt: [],
      options: {
        ...baseOptions(modelOf([])),
        tools: [dup, dup],
      },
    })).toThrow("Duplicate tool name: same");
  });

  it("interrupt():中止后驱动到底,收到 result(interrupted)", async () => {
    const controller = new AbortController();
    const q = query({
      prompt: [{ role: "user", content: "hi" }],
      options: {
        ...baseOptions(modelOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Hello" },
          { type: "text-delta", id: "t1", delta: " world" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", usage },
        ])),
        abortController: controller,
      },
    });

    const kinds: string[] = [];
    const iterator = q[Symbol.asyncIterator]();
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) break;
      kinds.push(value.type + (value.type === "result" ? `:${value.subtype}` : ""));
      if (value.type === "stream_event" && value.event.type === "text_delta") {
        controller.abort();
      }
    }
    // 中止后流收口:最后一条是 interrupted(不是 success)。
    expect(kinds.at(-1)).toBe("result:interrupted");
  });

  it("frames:同一批消息经 toRunStreamFrames 出旧 SSE 形状(step-start/text-delta/finish)", async () => {
    const q = query({
      prompt: [{ role: "user", content: "hi" }],
      options: baseOptions(modelOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "hey" },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ])),
    });

    const frames: RunStreamEvent[] = [];
    for await (const message of q) {
      frames.push(...toRunStreamFrames(message));
    }
    expect(frames.some((f) => f.type === "step-start")).toBe(true);
    expect(frames.some((f) => f.type === "text-delta")).toBe(true);
    expect(frames.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", text: "hey" });
  });
});
