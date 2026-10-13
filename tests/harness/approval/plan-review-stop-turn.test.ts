import { toRunStreamFrames } from "../../helpers/frames.js";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../../../packages/harness/src/agents/agent.js";
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createPlanGateState,
  textResult,
  tool,
  type PlanGateHandle,
  type PlanGateStore
} from "../../../packages/harness/src/tools/index.js";
import type { PlanReviewDecision } from "@eva/shared";
import type { PermissionResult } from "../../../packages/harness/src/query/types.js";

const usage = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
  raw: undefined
};

const handle: PlanGateHandle = {
  planId: "p1",
  planPath: "/repo/.eva/plan-gate/p1/current.md",
  planRelPath: ".eva/plan-gate/p1/current.md"
};

const store: PlanGateStore = {
  enter: async () => handle,
  readPlan: async () => "# Plan",
  recordRevision: async () => 1,
  approve: async () => undefined,
  reject: async () => undefined
};

const dummy = tool({
  name: "write",
  description: "dummy",
  inputSchema: z.object({}),
  execute: async () => textResult("should-not-run")
});

const modelWithExitThenText = (counter: { calls: number }) =>
  new MockLanguageModelV4({
    doStream: async () => {
      counter.calls += 1;
      const chunks =
        counter.calls === 1
          ? [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "tc-exit",
                toolName: "exit_plan_mode",
                input: "{}"
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

/**
 * plan review 搬进 canUseTool(plan §3.4):server 在里面读 plan、发审批帧、
 * 拿决策,然后按 outcome 返回 allow(deny)/deny。
 */
const permissionForDecision = (decision: PlanReviewDecision["outcome"]): PermissionResult => {
  switch (decision) {
    case "approve":
      return { behavior: "allow", updatedInput: { decision: { outcome: "approve" } } };
    case "revise":
      return {
        behavior: "deny",
        message: "User rejected the plan. Feedback:\n\n改\n\nRevise the plan and call exit_plan_mode again.",
      };
    case "reject":
      return {
        behavior: "deny",
        message: "Plan rejected. Plan mode remains active.",
        interrupt: true,
        isError: true,
      };
    case "reject_and_exit":
      return {
        behavior: "deny",
        message: "Plan rejected by user. Plan mode deactivated.",
        interrupt: true,
        isError: true,
      };
    case "dismissed":
      return { behavior: "deny", message: "Plan approval dismissed. Plan mode remains active." };
  }
};

const runOnce = async (decision: PlanReviewDecision["outcome"]) => {
  const state = createPlanGateState({ active: false });
  state.enter(handle);
  const counter = { calls: 0 };
  const agent = createAgent({
    model: modelWithExitThenText(counter),
    tools: [
      createExitPlanModeTool(store, state),
      dummy
    ],
    maxSteps: 5,
    canUseTool: async () => permissionForDecision(decision),
  });

  for await (const message of agent.stream({ messages: [{ role: "user", content: "exit" }] })) {
    for (const _ of toRunStreamFrames(message)) {
    void _;
  
    }
  }

  return counter.calls;
};

describe("plan review stopTurn", () => {
  it("reject / reject_and_exit 后 loop 不再进下一步(interrupt 结束本轮)", async () => {
    expect(await runOnce("reject")).toBe(1);
    expect(await runOnce("reject_and_exit")).toBe(1);
  });

  it("revise 不终止,loop 继续进下一步", async () => {
    expect(await runOnce("revise")).toBe(2);
  });

  it("dismissed 不终止,loop 继续进下一步", async () => {
    expect(await runOnce("dismissed")).toBe(2);
  });
});
