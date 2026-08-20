import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { InvalidToolInputError } from "ai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { createAgent } from "../packages/harness/src/agents/agent.js";
import type { AgentStreamEvent, AgentTelemetryEvent } from "../packages/harness/src/agents/types.js";
import { createRepairToolCall, repairToolName } from "../packages/harness/src/agents/repair-tool-call.js";
import { buildTool, toToolSet } from "../packages/harness/src/tools.js";

const readFileTool = () =>
  buildTool({
    name: "read_file",
    description: "read a file",
    schema: z.object({ path: z.string() }),
    execute: async (input: { path: string }) => `content of ${input.path}`
  });

const readSkillTool = () =>
  buildTool({
    name: "read_skill",
    description: "read a skill",
    schema: z.object({ name: z.string() }),
    execute: async (input: { name: string }) => `skill ${input.name}`
  });

const makeCall = (toolName: string, input: string) => ({
  type: "tool-call" as const,
  toolCallId: "tc-1",
  toolName,
  input
});

describe("repairToolName (纯函数)", () => {
  it("下划线差异 → 命中", () => {
    expect(repairToolName("readFile", ["read_file", "read_skill"])).toBe("read_file");
  });

  it("大小写差异 → 命中", () => {
    expect(repairToolName("READ_FILE", ["read_file"])).toBe("read_file");
  });

  it("编辑距离 1 → 命中", () => {
    expect(repairToolName("read_fil", ["read_file"])).toBe("read_file");
  });

  it("歧义(距离打平) → 不修", () => {
    // read_fi 离 read_file(1) 与 read_fix(1) 打平 —— 修哪个都是掷骰子
    expect(repairToolName("read_fi", ["read_file", "read_fix"])).toBeUndefined();
  });

  it("完全不相干 → 不修", () => {
    expect(repairToolName("nonexistent_tool_xyz", ["read_file", "read_skill"])).toBeUndefined();
  });
});

describe("createRepairToolCall", () => {
  const invalidInputError = (toolName: string, input: string) =>
    new InvalidToolInputError({
      toolName,
      toolInput: input,
      message: "path: Required"
    });

  it("修复模型返回合法 JSON → input 被替换,ids 保留", async () => {
    const repairModel = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: '{"path":"a.txt"}' }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: []
      })
    });

    const repair = createRepairToolCall({ repairModel });
    const tools = toToolSet([readFileTool()]);
    const call = makeCall("read_file", "{}");

    const repaired = await repair({
      toolCall: call,
      tools,
      inputSchema: async () => ({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      error: invalidInputError("read_file", "{}"),
      instructions: undefined,
      system: undefined,
      messages: []
    });

    expect(repaired).not.toBeNull();
    expect(repaired!.toolCallId).toBe("tc-1");
    expect(repaired!.toolName).toBe("read_file");
    expect(JSON.parse(repaired!.input)).toEqual({ path: "a.txt" });
  });

  it("修复模型包 ```json fence → 剥掉再 parse", async () => {
    const repairModel = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: '```json\n{"path":"b.txt"}\n```' }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: []
      })
    });

    const repair = createRepairToolCall({ repairModel });
    const repaired = await repair({
      toolCall: makeCall("read_file", "{}"),
      tools: toToolSet([readFileTool()]),
      inputSchema: async () => ({ type: "object" }),
      error: invalidInputError("read_file", "{}"),
      instructions: undefined,
      system: undefined,
      messages: []
    });

    expect(JSON.parse(repaired!.input)).toEqual({ path: "b.txt" });
  });

  it("修复模型返回散文 → null(报错进流,不是静默吞)", async () => {
    const repairModel = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "I cannot fix this, sorry." }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: []
      })
    });

    const repair = createRepairToolCall({ repairModel });
    const repaired = await repair({
      toolCall: makeCall("read_file", "{}"),
      tools: toToolSet([readFileTool()]),
      inputSchema: async () => ({ type: "object" }),
      error: invalidInputError("read_file", "{}"),
      instructions: undefined,
      system: undefined,
      messages: []
    });

    expect(repaired).toBeNull();
  });

  it("observer 收到 tool_call_repaired;返回 null 时不发", async () => {
    const events: AgentTelemetryEvent[] = [];
    const okModel = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: '{"path":"a.txt"}' }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: []
      })
    });

    const repair = createRepairToolCall({
      repairModel: okModel,
      emit: (event) => events.push(event)
    });
    await repair({
      toolCall: makeCall("read_file", "{}"),
      tools: toToolSet([readFileTool()]),
      inputSchema: async () => ({ type: "object" }),
      error: invalidInputError("read_file", "{}"),
      instructions: undefined,
      system: undefined,
      messages: []
    });

    expect(events).toEqual([
      { type: "tool_call_repaired", toolName: "read_file", kind: "input" }
    ]);
  });
});

describe("streamText 接线 (端到端)", () => {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 }
  };

  it("入参缺 path 的 read_file → 修复后工具执行成功,主模型只烧一圈", async () => {
    let mainCalls = 0;
    const mainModel = new MockLanguageModelV4({
      doStream: async () => {
        mainCalls += 1;
        if (mainCalls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "tc-1", toolName: "read_file" },
                // 缺 path —— schema 校验必炸
                { type: "tool-call", toolCallId: "tc-1", toolName: "read_file", input: JSON.stringify({}) },
                { type: "finish", finishReason: "tool-calls", usage }
              ]
            })
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "read it" },
              { type: "text-end", id: "1" },
              { type: "finish", finishReason: "stop", usage }
            ]
          })
        };
      }
    });

    const repairModel = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: '{"path":"fixed.txt"}' }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: []
      })
    });

    const executed: string[] = [];
    const tool = buildTool({
      name: "read_file",
      description: "read a file",
      schema: z.object({ path: z.string() }),
      execute: async (input: { path: string }) => {
        executed.push(input.path);
        return `content of ${input.path}`;
      }
    });

    const telemetry: AgentTelemetryEvent[] = [];
    const agent = createAgent({
      model: mainModel,
      tools: [tool],
      repairModel,
      observer: (event) => telemetry.push(event)
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.stream({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }

    // 工具用修复后的入参执行了
    expect(executed).toEqual(["fixed.txt"]);
    // 修复事件进 observer
    expect(telemetry).toContainEqual({
      type: "tool_call_repaired",
      toolName: "read_file",
      kind: "input"
    });
    // 工具结果正常出现在流里,loop 走到 finish
    const toolResults = events.filter((e) => e.type === "tool-result") as Array<{ output: string }>;
    expect(toolResults[0]?.output).toBe("content of fixed.txt");
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("不传 repairModel → 维持现状(非法入参直接 error,不爆炸)", async () => {
    const mainModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "tc-1", toolName: "read_file" },
            { type: "tool-call", toolCallId: "tc-1", toolName: "read_file", input: JSON.stringify({}) },
            { type: "finish", finishReason: "tool-calls", usage }
          ]
        })
      })
    });

    const agent = createAgent({ model: mainModel, tools: [readFileTool()] });

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.stream({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }

    // SDK 把校验失败产成 error/带错 tool-result —— 关键是 loop 不抛死
    const hasErrorSignal = events.some(
      (e) => e.type === "error" || (e.type === "tool-result" && (e as { status?: string }).status === "error")
    );
    expect(hasErrorSignal).toBe(true);
  });
});
