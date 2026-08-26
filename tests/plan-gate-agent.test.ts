import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../packages/harness/src/agents/agent.js";
import {
  buildTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createPlanGateState,
  type AgentTool,
  type PlanGateStore
} from "../packages/harness/src/tools/index.js";

const usage = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
  raw: undefined
};

describe("plan gate agent 集成（同 run 进出）", () => {
  it("enter → write plan → exit(approve) → write code 全程同 run", async () => {
    const handle = {
      planId: "p1",
      planPath: "/repo/.eva/plan-gate/p1/current.md",
      planRelPath: ".eva/plan-gate/p1/current.md"
    };
    let planContent = "";
    const writes: string[] = [];
    const approvals: string[] = [];

    const writeTool: AgentTool = buildTool({
      name: "write",
      description: "write file",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      needsApproval: true,
      execute: async ({ path: target, content }) => {
        writes.push(target);
        if (target === handle.planRelPath) planContent = content;
        return `wrote ${target}`;
      }
    });

    const store: PlanGateStore = {
      enter: async () => handle,
      readPlan: async () => planContent,
      recordRevision: async () => 1,
      approve: async () => undefined
    };
    const state = createPlanGateState({ active: false });

    const calls = [
      { tool: "enter_plan_mode", input: "{}" },
      { tool: "write", input: JSON.stringify({ path: handle.planRelPath, content: "# Plan" }) },
      { tool: "exit_plan_mode", input: "{}" },
      { tool: "write", input: JSON.stringify({ path: "src/a.ts", content: "code" }) }
    ];
    let callIndex = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callIndex += 1;
        const call = calls[callIndex - 1];
        const chunks = call
          ? [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: `tc-${callIndex}`,
                toolName: call.tool,
                input: call.input
              },
              { type: "finish" as const, finishReason: "tool-calls" as const, usage }
            ]
          : [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "1" },
              { type: "text-delta" as const, id: "1", delta: "done" },
              { type: "text-end" as const, id: "1" },
              { type: "finish" as const, finishReason: "stop" as const, usage }
            ];
        return { stream: simulateReadableStream({ chunks }) };
      }
    });

    const agent = createAgent({
      model,
      tools: [
        writeTool,
        createEnterPlanModeTool(store, state),
        createExitPlanModeTool(store, state)
      ],
      maxSteps: 10,
      planGateState: state,
      requestApproval: async ({ toolName }) => {
        approvals.push(toolName);
        return true;
      }
    });

    for await (const _ of agent.stream({ messages: [{ role: "user", content: "plan then code" }] })) {
      void _;
    }

    expect(writes).toEqual([handle.planRelPath, "src/a.ts"]);
    // write 走审批(测试闭包全 true),enter 不审批,exit 审批一次;exit 后 write 恢复正常审批路径。
    expect(approvals).toEqual(["write", "exit_plan_mode", "write"]);
    expect(state.current().active).toBe(false);
    expect(planContent).toBe("# Plan");
  });
});
