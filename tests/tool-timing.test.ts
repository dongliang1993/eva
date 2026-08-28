import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import {
  buildJsonSchemaTool,
  buildTool,
  createAgent,
  createPlanGateState,
  createToolTimingState,
  Semaphore,
  TOOL_CALL_ABORTED_OUTPUT,
  withApproval,
  withConcurrencyCap,
  withExecTiming,
  withPlanGate,
  type AgentTelemetryEvent,
  type AgentTool,
  type ToolTimingState
} from "../packages/harness/src/index.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const execOf = (
  tool: AgentTool
): ((input: unknown, options?: unknown) => Promise<unknown>) => {
  const execute = tool.tool.execute;
  if (typeof execute !== "function") throw new Error("tool has no execute");
  return execute as (input: unknown, options?: unknown) => Promise<unknown>;
};

describe("工具三段计时(T50)", () => {
  it("审批等 100ms、排队等 50ms、执行 50ms 的调用拆成三个独立数字", async () => {
    const timing: ToolTimingState = createToolTimingState();
    const limiter = new Semaphore(1);
    const tool = buildTool({
      name: "t",
      description: "t",
      inputSchema: z.object({}),
      readOnly: true,
      needsApproval: true,
      execute: async () => {
        await sleep(50);
        return "ok";
      }
    });

    // 与 createAgent 同序:execTiming 最内 → cap → approval(执行序 approval → cap → exec)。
    const wrapped = withApproval(
      withConcurrencyCap(withExecTiming(tool, timing), limiter, timing),
      async () => {
        await sleep(100);
        return true;
      },
      undefined,
      timing
    );

    // 先占住唯一的帽位,150ms 后释放 —— 审批要等 100ms,帽在审批结束后还占着,
    // 才能制造出确定的排队等待(过早释放的话 cap.acquire 到的时候帽已经空了)。
    const hold = await limiter.acquire();
    const pending = execOf(wrapped)({}, { toolCallId: "call-1" });
    setTimeout(() => hold(), 150);
    await pending;

    const snap = timing.take("call-1");
    expect(snap.approvalWaitMs).toBeGreaterThanOrEqual(90);
    expect(snap.queueWaitMs).toBeGreaterThanOrEqual(40);
    expect(snap.execMs).toBeGreaterThanOrEqual(45);
    // 三者之和与任何单一字段都不相等 —— 它们是三段,不是一个数的三种写法。
    const total = snap.approvalWaitMs + snap.queueWaitMs + snap.execMs;
    expect(total).toBeGreaterThan(snap.approvalWaitMs);
    expect(total).toBeGreaterThan(snap.execMs);
  });

  it("无审批无排队的只读工具:两个等待字段是 0,exec 与手工计时吻合", async () => {
    const timing = createToolTimingState();
    const tool = buildTool({
      name: "t",
      description: "t",
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => {
        await sleep(50);
        return "ok";
      }
    });
    const wrapped = withConcurrencyCap(
      withExecTiming(tool, timing),
      new Semaphore(10),
      timing
    );

    const start = Date.now();
    await execOf(wrapped)({}, { toolCallId: "call-2" });
    const wall = Date.now() - start;

    const snap = timing.take("call-2");
    expect(snap.approvalWaitMs).toBe(0);
    expect(snap.queueWaitMs).toBeLessThan(30); // 无竞争 ≈ 0
    expect(snap.execMs).toBeGreaterThanOrEqual(45);
    expect(snap.execMs).toBeLessThanOrEqual(wall + 10);
  });

  it("plan gate 挡掉的 write:三段全 0,无异常", async () => {
    const timing = createToolTimingState();
    const tool = buildTool({
      name: "write",
      description: "t",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      needsApproval: true,
      execute: async () => "written"
    });
    const gateState = createPlanGateState({
      active: true,
      planId: "p1",
      planPath: "/ws/.eva/plan-gate/p1/current.md",
      planRelPath: ".eva/plan-gate/p1/current.md"
    });
    const wrapped = withPlanGate(withExecTiming(tool, timing), gateState);

    const output = await execOf(wrapped)(
      { path: "/ws/src/index.ts", content: "x" },
      { toolCallId: "call-3" }
    );
    expect(String(output)).toContain("[Plan Mode]");

    const snap = timing.take("call-3");
    expect(snap).toEqual({
      approvalWaitMs: 0,
      queueWaitMs: 0,
      execMs: 0,
      execAborted: false
    });
  });

  it("工具内部抛异常:仍记 exec(到抛出为止),输出是 Error: 前缀", async () => {
    const timing = createToolTimingState();
    const tool = buildTool({
      name: "t",
      description: "t",
      inputSchema: z.object({}),
      execute: async () => {
        await sleep(30);
        throw new Error("boom");
      }
    });
    const wrapped = withExecTiming(tool, timing);

    const output = await execOf(wrapped)({}, { toolCallId: "call-4" });
    expect(String(output)).toMatch(/^Error:/);

    const snap = timing.take("call-4");
    expect(snap.execMs).toBeGreaterThanOrEqual(25);
    expect(snap.execAborted).toBe(false);
  });

  it("abort 抢在 execute 之前完成:exec 有值且标 execAborted", async () => {
    const timing = createToolTimingState();
    const tool = buildTool({
      name: "t",
      description: "t",
      inputSchema: z.object({}),
      execute: async () => {
        await sleep(500);
        return "should never reach";
      }
    });
    const wrapped = withExecTiming(tool, timing);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const output = await execOf(wrapped)({}, {
      toolCallId: "call-5",
      abortSignal: controller.signal
    });

    expect(output).toBe(TOOL_CALL_ABORTED_OUTPUT);
    const snap = timing.take("call-5");
    expect(snap.execMs).toBeGreaterThanOrEqual(20);
    expect(snap.execMs).toBeLessThan(400); // 没等满 500ms —— 记的是「到被中止为止」
    expect(snap.execAborted).toBe(true);
  });

  it("MCP 工具(buildJsonSchemaTool)与内建工具(buildTool)都有 exec", async () => {
    const timing = createToolTimingState();
    const mcpTool = buildJsonSchemaTool({
      name: "mcp__srv__do",
      description: "mcp tool",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        await sleep(40);
        return "mcp ok";
      }
    });

    await execOf(withExecTiming(mcpTool, timing))({}, { toolCallId: "call-6" });
    const snap = timing.take("call-6");
    expect(snap.execMs).toBeGreaterThanOrEqual(35);
  });

  it("agent 级:审批等待与执行分段进 tool_call_completed 事件", async () => {
    const events: AgentTelemetryEvent[] = [];
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 }
    };
    const dangerousTool = buildTool({
      name: "danger",
      description: "t",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => {
        await sleep(30);
        return "done";
      }
    });

    let callIndex = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const call = callIndex;
        callIndex += 1;
        if (call === 0) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "tc-1", toolName: "danger" },
                { type: "tool-call", toolCallId: "tc-1", toolName: "danger", input: "{}" },
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
              { type: "text-delta", id: "1", delta: "ok" },
              { type: "text-end", id: "1" },
              { type: "finish", finishReason: "stop", usage }
            ]
          })
        };
      }
    });

    const agent = createAgent({
      model,
      tools: [dangerousTool],
      maxSteps: 5,
      observer: (event) => events.push(event),
      requestApproval: async () => {
        await sleep(100);
        return true;
      }
    });

    await agent.invoke({ messages: [{ role: "user", content: "hi" }] });

    const completed = events.find((e) => e.type === "tool_call_completed");
    expect(completed).toBeDefined();
    if (completed?.type !== "tool_call_completed") throw new Error("unreachable");
    expect(completed.approvalWaitMs).toBeGreaterThanOrEqual(90);
    expect(completed.toolExecMs).toBeGreaterThanOrEqual(25);
    expect(completed.queueWaitMs).toBe(0); // 写类工具不吃只读帽
    // 三段独立:审批等待没有混进执行时长
    expect(completed.toolExecMs).toBeLessThan(completed.approvalWaitMs ?? 0);
  });

  it("没 record 过的 toolCallId,take 返回全 0 快照(plan gate 语义)", () => {
    const timing = createToolTimingState();
    expect(timing.take("never-seen")).toEqual({
      approvalWaitMs: 0,
      queueWaitMs: 0,
      execMs: 0,
      execAborted: false
    });
  });
});
