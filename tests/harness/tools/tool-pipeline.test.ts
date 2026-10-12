import { describe, expect, it } from "vitest";
import { z } from "zod";

import { textResult, tool } from "../../../packages/harness/src/tools/tool.js";
import { createPlanGateState } from "../../../packages/harness/src/tools/plan-gate/state.js";
import { buildToolPipeline } from "../../../packages/harness/src/tools/tool-pipeline.js";
import { textOf } from "../../../packages/harness/src/tools/tool.js";

/** 经装配链(toAiTool → runToolCall)调一个工具:唯一能触发权限/计时的入口。 */
const runAssembled = async (
  pipeline: ReturnType<typeof buildToolPipeline>,
  name: string,
  input: Record<string, unknown>,
  toolUseID: string,
): Promise<string> => {
  const aiTool = pipeline.toolSet[name]!;
  const result = await aiTool.execute!(input, { toolCallId: toolUseID } as never);
  return textOf(result as import("../../../packages/harness/src/query/types.js").ToolResult);
};

describe("tool pipeline", () => {
  it("canUseTool deny:execute 不跑,exec/queue 计时为 0,timing 保留在 pipeline.timings", async () => {
    let executions = 0;
    const state = createPlanGateState({
      active: true,
      planId: "p1",
      planPath: "/ws/.eva/plan-gate/p1/current.md",
      planRelPath: ".eva/plan-gate/p1/current.md",
    });
    const write = tool({
      name: "write",
      description: "write",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => {
        executions += 1;
        return textResult("written");
      },
    });
    // 放行链第一步:plan gate 拦非 plan 路径写(server 侧的形状,harness 只见 deny)。
    const pipeline = buildToolPipeline({
      tools: [write],
      canUseTool: async (toolName, input) => {
        const snap = state.current();
        if (
          snap.active &&
          toolName === "write" &&
          snap.planPath !== undefined &&
          snap.planRelPath !== undefined &&
          (input.path as string) !== snap.planRelPath
        ) {
          return {
            behavior: "deny",
            message: "[Plan Mode] Only read-only tools and the current plan file are available.",
          };
        }
        return { behavior: "allow" } as const;
      },
    });
    expect(pipeline.catalog.has("write")).toBe(true);
    expect(pipeline.catalog.has("tool_search")).toBe(true);

    const output = await runAssembled(pipeline, "write", { path: "/ws/src/index.ts", content: "x" }, "call-1");
    expect(output).toContain("[Plan Mode]");
    expect(executions).toBe(0);
    expect(pipeline.timings.get("call-1")).toEqual({
      approval_wait_ms: expect.any(Number),
      queue_wait_ms: 0,
      exec_ms: 0,
      aborted: false,
    });
  });

  it("deny.interrupt=true → tookInterruptSignal 置位;drain 等在飞收口", async () => {
    const exitTool = tool({
      name: "exit_plan_mode",
      description: "exit",
      inputSchema: z.object({}).passthrough(),
      execute: async () => textResult("should not run"),
    });
    const pipeline = buildToolPipeline({
      tools: [exitTool],
      canUseTool: async () => ({
        behavior: "deny",
        message: "Plan rejected. Plan mode remains active.",
        interrupt: true,
        isError: true,
      }),
    });
    expect(pipeline.tookInterruptSignal()).toBe(false);
    const output = await runAssembled(pipeline, "exit_plan_mode", {}, "call-2");
    expect(output).toBe("Error: Plan rejected. Plan mode remains active.");
    expect(pipeline.tookInterruptSignal()).toBe(true);
    await pipeline.drain();
  });

  it("重名工具在装配期即抛(含 tool_search 保留名)", () => {
    const dup = tool({
      name: "tool_search",
      description: "dup",
      inputSchema: z.object({}),
      execute: async () => textResult("x"),
    });
    expect(() => buildToolPipeline({ tools: [dup] })).toThrow("Duplicate tool name");
  });
});
