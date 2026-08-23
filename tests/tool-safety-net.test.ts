/**
 * T39:工具数 >40 安全网(Alma PM-011,main:90600-90606)。
 *
 * 未显式设 activeTools 时,工具总数 > TOOL_COUNT_SAFETY_LIMIT(40)退化到最小集
 * (fs 读写 + bash)+ 发 tool_count_degraded;显式设了就尊重(哪怕 >40 也不钳)。
 */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  applyToolCountSafetyNet,
  TOOL_COUNT_SAFETY_LIMIT,
} from "../packages/harness/src/agents/tool-safety-net.js";
import { createAgent } from "../packages/harness/src/agents/agent.js";
import type { AgentTelemetryEvent } from "../packages/harness/src/agents/observer.js";
import { buildTool, type AgentTool } from "../packages/harness/src/tools/index.js";

const usage = { promptTokens: 5, completionTokens: 5, totalTokens: 10 };

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

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe("applyToolCountSafetyNet", () => {
  it("45 工具 + 无 activeToolNames → 退化到最小集(degraded)", () => {
    const tools = toolMap(45, ["read_file", "write_file", "bash"]);
    const { tools: out, degraded } = applyToolCountSafetyNet(tools);
    expect(degraded).toBe(true);
    // 最小集 ∩ 实际存在:read_file/write_file/bash 在,edit_file/list_dir 不在。
    expect([...out.keys()].sort()).toEqual(["bash", "read_file", "write_file"]);
  });

  it("45 工具 + 显式 activeToolNames 含某 MCP 工具 → 按它过滤,不退化", () => {
    const tools = toolMap(45, ["mcp__x__y", "read_file"]);
    const { tools: out, degraded } = applyToolCountSafetyNet(tools, [
      "read_file",
      "mcp__x__y",
    ]);
    expect(degraded).toBe(false);
    expect([...out.keys()].sort()).toEqual(["mcp__x__y", "read_file"]);
  });

  it("30 工具 + 无 activeToolNames → 原样,不退化", () => {
    const tools = toolMap(30);
    const { tools: out, degraded } = applyToolCountSafetyNet(tools);
    expect(degraded).toBe(false);
    expect(out.size).toBe(30);
  });

  it("最小集里某工具不存在(没装 bash)→ 只留存在的,不崩", () => {
    const tools = toolMap(45, ["read_file"]); // 没 bash/write_file/...
    const { tools: out, degraded } = applyToolCountSafetyNet(tools);
    expect(degraded).toBe(true);
    expect([...out.keys()]).toEqual(["read_file"]);
  });

  it("恰好等于上限(40)不退化,超过才退化", () => {
    // 额外占一个不撞 filler 编号的具名工具,把总数顶到 limit / limit+1。
    const at = toolMap(TOOL_COUNT_SAFETY_LIMIT - 1, ["read_file"]);
    expect(at.size).toBe(TOOL_COUNT_SAFETY_LIMIT);
    expect(applyToolCountSafetyNet(at).degraded).toBe(false);
    const over = toolMap(TOOL_COUNT_SAFETY_LIMIT, ["read_file"]);
    expect(over.size).toBe(TOOL_COUNT_SAFETY_LIMIT + 1);
    expect(applyToolCountSafetyNet(over).degraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 接线:agent run 时超触发事件 + 模型只收到最小集
// ---------------------------------------------------------------------------

describe("agent 接线", () => {
  /** 记录最后一次 doStream 收到的 tools,首步 tool-call 收尾。 */
  const captureModel = (captured: { toolNames: string[] }) => {
    let callIndex = 0;
    return new MockLanguageModelV4({
      doStream: async (options) => {
        // SDK 传给 provider 的 tools 是数组(LanguageModelV4FunctionTool[]),取 name。
        captured.toolNames = (options.tools ?? []).map((t) => t.name);
        callIndex += 1;
        const chunks =
          callIndex === 1
            ? [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "tc-0",
                  toolName: "read_file",
                  input: JSON.stringify({}),
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

  it("45 工具无 activeToolNames → 发 tool_count_degraded,模型只收最小集", async () => {
    const captured = { toolNames: [] as string[] };
    const telemetry: AgentTelemetryEvent[] = [];
    const agent = createAgent({
      model: captureModel(captured),
      tools: [...toolMap(45, ["read_file", "write_file", "bash"]).values()],
      observer: (e) => telemetry.push(e),
    });

    for await (const _ of agent.stream({ messages: [{ role: "user", content: "hi" }] })) {
      void _;
    }

    expect(captured.toolNames.sort()).toEqual(["bash", "read_file", "write_file"]);
    const degraded = telemetry.find((e) => e.type === "tool_count_degraded");
    expect(degraded).toMatchObject({
      type: "tool_count_degraded",
      totalCount: 48,
      keptCount: 3,
      limit: TOOL_COUNT_SAFETY_LIMIT,
    });
  });

  it("30 工具无 activeToolNames → 不发事件,模型收全集", async () => {
    const captured = { toolNames: [] as string[] };
    const telemetry: AgentTelemetryEvent[] = [];
    const agent = createAgent({
      model: captureModel(captured),
      tools: [...toolMap(30, ["read_file"]).values()],
      observer: (e) => telemetry.push(e),
    });

    for await (const _ of agent.stream({ messages: [{ role: "user", content: "hi" }] })) {
      void _;
    }

    expect(captured.toolNames).toHaveLength(31);
    expect(telemetry.some((e) => e.type === "tool_count_degraded")).toBe(false);
  });
});
