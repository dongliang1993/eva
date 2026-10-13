import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { query } from "../../../packages/harness/src/query/query.js";
import { runSubagentQuery } from "../../../packages/harness/src/query/subagent-tool.js";
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

describe("subagent 递归 query()", () => {
  it("子代理消息带 parent_tool_use_id;工具调用走父的 canUseTool(agentID=子代理名)", async () => {
    const seenAgentIDs: Array<string | undefined> = [];
    const parentOptions: Options = {
      model: {
        languageModel: modelOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "child done" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", usage },
        ]) as never,
        id: "openai:child",
      },
      canUseTool: async (_toolName, _input, opts) => {
        seenAgentIDs.push(opts.agentID);
        return { behavior: "allow" as const };
      },
    };

    const messages: HarnessMessage[] = [];
    for await (const message of runSubagentQuery(
      { options: parentOptions, parentPrompt: [] },
      {
        subagentType: "explorer",
        definition: { description: "explore", prompt: "You are an explorer." },
        prompt: "find the answer",
        parentToolUseID: "parent-call-1",
        abortSignal: new AbortController().signal,
      },
    )) {
      messages.push(message);
    }

    // 每条消息都盖了 parent 派发 id;最后一条是子代理自己的 result。
    expect(messages.every((m) => m.parent_tool_use_id === "parent-call-1")).toBe(true);
    expect(messages.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    expect(messages[0]).toMatchObject({ type: "system", subtype: "init", model: "openai:child" });
  });

  it("tools 白名单过滤父工具;省略 = 继承全部", async () => {
    const childTool = tool({
      name: "child_only", description: "c", inputSchema: z.object({}),
      execute: async () => textResult("ok"),
    });
    // 白名单含 child_only → 注册;工具走 canUseTool(allow)。
    const options: Options = {
      model: {
        languageModel: modelOf([
          { type: "stream-start", warnings: [] },
          { type: "tool-input-start", id: "tc-1", toolName: "child_only" },
          { type: "tool-call", toolCallId: "tc-1", toolName: "child_only", input: "{}" },
          { type: "finish", finishReason: "tool-calls", usage },
          // 第二步模型不产出(省事):子代理收口在 maxTurns?不 —— 直接第二步文本。
        ]) as never,
        id: "openai:child",
      },
      tools: [childTool],
      canUseTool: async () => ({ behavior: "allow" as const }),
    };

    const q = query({
      prompt: [],
      options: { ...options, maxTurns: 2 },
    });
    const tools: string[] = [];
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        tools.push(...message.tools);
      }
    }
    expect(tools).toContain("child_only");
  });
});
