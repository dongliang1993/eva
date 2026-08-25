/**
 * T39/T43:工具数 >40 安全网接线。
 *
 * T43 语义:超限不再裁 toolSet,而是首步 active core tools + tool_search;
 * 模型用 tool_search 激活后,下一 step 的 provider tools 并入被激活工具。
 */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../packages/harness/src/agents/agent.js";
import type { AgentTelemetryEvent } from "../packages/harness/src/agents/observer.js";
import { TOOL_COUNT_SAFETY_LIMIT } from "../packages/harness/src/agents/tool-safety-net.js";
import { buildTool, type AgentTool } from "../packages/harness/src/tools/index.js";

const usage = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
  raw: undefined,
};

/** 名为 name 的最小工具。 */
const probeTool = (name: string): AgentTool =>
  buildTool({
    name,
    description: `probe ${name}`,
    inputSchema: z.object({ n: z.number().optional() }),
    execute: async () => `${name} ok`,
  });

/** count 个工具:filler-0..N,外加 extraNames 里的具名工具。 */
const toolMap = (count: number, extraNames: readonly string[] = []) => {
  const map = new Map<string, AgentTool>();
  for (let i = 0; i < count; i += 1) map.set(`filler-${i}`, probeTool(`filler-${i}`));
  for (const name of extraNames) map.set(name, probeTool(name));
  return map;
};

describe("agent 接线", () => {
  /** 记录每次 doStream 收到的 tools;首步 tool_search,第二步文本收尾。 */
  const captureModel = (captured: { calls: string[][] }) => {
    let callIndex = 0;
    return new MockLanguageModelV4({
      doStream: async (options) => {
        captured.calls.push((options.tools ?? []).map((t) => t.name));
        callIndex += 1;
        const chunks =
          callIndex === 1
            ? [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "tc-search",
                  toolName: "tool_search",
                  input: JSON.stringify({ query: "github create issue" }),
                },
                { type: "finish" as const, finishReason: "tool-calls" as const, usage },
              ]
            : [
                { type: "stream-start" as const, warnings: [] },
                { type: "text-start" as const, id: "1" },
                { type: "text-delta" as const, id: "1", delta: "done" },
                { type: "text-end" as const, id: "1" },
                { type: "finish" as const, finishReason: "stop" as const, usage },
              ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
  };

  it("45 tools without activeToolNames: first step core only, search activates MCP for step 2", async () => {
    const captured = { calls: [] as string[][] };
    const telemetry: AgentTelemetryEvent[] = [];
    const tools = toolMap(45, [
      "read_file",
      "write_file",
      "bash",
      "mcp__github__create_issue",
    ]);
    const agent = createAgent({
      model: captureModel(captured),
      tools: [...tools.values()],
      observer: (e) => telemetry.push(e),
    });

    for await (const _ of agent.stream({ messages: [{ role: "user", content: "hi" }] })) {
      void _;
    }

    expect(captured.calls).toHaveLength(2);
    expect(captured.calls[0]!.sort()).toEqual([
      "bash",
      "read_file",
      "tool_search",
      "write_file",
    ]);
    expect(captured.calls[1]).toContain("mcp__github__create_issue");
    expect(captured.calls[1]).toContain("tool_search");

    const degraded = telemetry.find((e) => e.type === "tool_count_degraded");
    expect(degraded).toMatchObject({
      type: "tool_count_degraded",
      totalCount: tools.size + 1, // createAgent 注入的 tool_search 也在 catalog 里
      keptCount: 4,
      limit: TOOL_COUNT_SAFETY_LIMIT,
    });
  });

  it("30 tools without activeToolNames: no event, provider gets the full set", async () => {
    const captured = { calls: [] as string[][] };
    const telemetry: AgentTelemetryEvent[] = [];
    const agent = createAgent({
      model: captureModel(captured),
      tools: [...toolMap(30, ["read_file"]).values()],
      observer: (e) => telemetry.push(e),
    });

    for await (const _ of agent.stream({ messages: [{ role: "user", content: "hi" }] })) {
      void _;
    }

    expect(captured.calls[0]).toHaveLength(32);
    expect(telemetry.some((e) => e.type === "tool_count_degraded")).toBe(false);
  });
});
