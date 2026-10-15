import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { ModelMessage, ToolModelMessage } from "ai";
import { z } from "zod";

import { query } from "../../../packages/harness/src/query/query.js";
import { errorResult, textResult, tool } from "../../../packages/harness/src/tools/tool.js";
import { applyToolResultBudget } from "../../../packages/harness/src/context/tool-result-budget.js";
import { toRunStreamFrames } from "../../helpers/frames.js";
import type { RunStreamEvent } from "@eva/shared";

/**
 * 工具成败的单一通道(Claude Code 的 tool_result.is_error):
 * ToolResult.isError → output.type=error-text → 模型请求 / user 消息 / SSE 帧。
 * 文本里有没有 "Error:" 前缀不参与判定。
 */

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const toolCallThenStop = () => {
  const prompts: unknown[] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      call += 1;
      const chunks = call === 1
        ? [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "tc-fail", toolName: "fails", input: "{}" },
          { type: "tool-call", toolCallId: "tc-ok", toolName: "logs", input: "{}" },
          { type: "finish", finishReason: "tool-calls", usage },
        ]
        : [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "done" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: "stop", usage },
        ];
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  });
  return { model, prompts };
};

describe("工具错误通道", () => {
  it("isError → error-text 进模型请求与帧;成功结果文本以 Error: 开头仍是 success", async () => {
    const { model, prompts } = toolCallThenStop();
    const frames: RunStreamEvent[] = [];
    for await (const message of query({
      prompt: [{ role: "user", content: "go" }],
      options: {
        model: { languageModel: model as never, id: "openai:t" },
        canUseTool: async () => ({ behavior: "allow" as const }),
        tools: [
          tool({
            name: "fails", description: "f", inputSchema: z.object({}),
            execute: async () => errorResult("disk full"),
          }),
          tool({
            name: "logs", description: "l", inputSchema: z.object({}),
            execute: async () => textResult("Error: line from a log file"),
          }),
        ],
      },
    })) {
      frames.push(...toRunStreamFrames(message));
    }

    const results = frames.filter((f) => f.type === "tool-result");
    expect(results.map((f) => [f.toolCallId, f.status, f.output])).toEqual([
      ["tc-fail", "error", "Error: disk full"],
      ["tc-ok", "success", "Error: line from a log file"],
    ]);

    // 第二次模型请求里的 tool 消息:失败那条是 error-text(provider → is_error:true)。
    const second = prompts[1] as ModelMessage[];
    const toolMessage = second.find((m) => m.role === "tool") as ToolModelMessage | undefined;
    const outputs = toolMessage?.content.map((p) =>
      p.type === "tool-result" ? [p.toolCallId, p.output.type] : [p.type]);
    expect(outputs).toEqual([["tc-fail", "error-text"], ["tc-ok", "text"]]);
  });

  it("tool-result budget 裁剪 error 结果后仍是 error-text(只裁正文,不改成败)", () => {
    const huge = "x".repeat(400_000);
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "read_file", input: {} }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result", toolCallId: "tc-1", toolName: "read_file",
          output: { type: "error-text", value: huge },
        }],
      },
      { role: "user", content: "next" },
    ];
    const trimmed = applyToolResultBudget(messages, {
      contextWindow: 8_000, reservedOutputTokens: 1_000,
    } as never);
    const tool = trimmed.find((m) => m.role === "tool") as ToolModelMessage;
    const part = tool.content[0];
    if (part?.type !== "tool-result") throw new Error("unreachable");
    expect(part.output.type).toBe("error-text");
    expect(String((part.output as { value: unknown }).value)).toContain("omitted");
  });
});
