import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildTool } from "../../../packages/harness/src/tools/build-tool.js";
import { createPlanGateState } from "../../../packages/harness/src/tools/plan-gate/state.js";
import { buildToolPipeline } from "../../../packages/harness/src/tools/tool-pipeline.js";
import type { AgentTool } from "../../../packages/harness/src/tools/build-tool.js";

const execute = (tool: AgentTool, input: unknown, toolCallId: string) => {
  if (typeof tool.tool.execute !== "function") throw new Error("tool has no execute");
  return tool.tool.execute(input, { toolCallId, messages: [] });
};

describe("tool pipeline", () => {
  it("plan gate 位于审批与执行之外，并与 wrappers 共享同一 timing state", async () => {
    let approvals = 0;
    let executions = 0;
    const gate = createPlanGateState({
      active: true,
      planId: "p1",
      planPath: "/ws/.eva/plan-gate/p1/current.md",
      planRelPath: ".eva/plan-gate/p1/current.md",
    });
    const write = buildTool({
      name: "write",
      description: "write",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      needsApproval: true,
      execute: async () => {
        executions += 1;
        return "written";
      },
    });
    const pipeline = buildToolPipeline({
      tools: [write],
      planGateState: gate,
      requestApproval: async () => {
        approvals += 1;
        return true;
      },
    });
    const wrapped = pipeline.tools.find((tool) => tool.name === "write");
    expect(wrapped).toBeDefined();
    expect(pipeline.tools.some((tool) => tool.name === "tool_search")).toBe(true);

    const output = await execute(
      wrapped!,
      { path: "/ws/src/index.ts", content: "x" },
      "call-1",
    );
    expect(String(output)).toContain("[Plan Mode]");
    expect(approvals).toBe(0);
    expect(executions).toBe(0);
    expect(pipeline.toolTiming.take("call-1")).toEqual({
      approvalWaitMs: 0,
      queueWaitMs: 0,
      execMs: 0,
      execAborted: false,
    });
  });
});
