import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../packages/harness/src/agents/agent.js";
import {
  buildTool,
  createExitPlanModeTool,
  createPlanGateState,
  type PlanGateHandle,
  type PlanGateStore
} from "../packages/harness/src/tools/index.js";
import type { PlanReviewDecision } from "@eva/shared";

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

const dummy = buildTool({
  name: "write",
  description: "dummy",
  inputSchema: z.object({}),
  execute: async () => "should-not-run"
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

const runOnce = async (decision: PlanReviewDecision) => {
  const state = createPlanGateState({ active: false });
  state.enter(handle);
  const counter = { calls: 0 };
  const agent = createAgent({
    model: modelWithExitThenText(counter),
    tools: [
      createExitPlanModeTool(store, state, async () => decision),
      dummy
    ],
    maxSteps: 5,
    planGateState: state
  });

  for await (const _ of agent.stream({ messages: [{ role: "user", content: "exit" }] })) {
    void _;
  }

  return counter.calls;
};

describe("plan review stopTurn", () => {
  it("reject / reject_and_exit 后 loop 不再进下一步", async () => {
    expect(await runOnce({ outcome: "reject", decidedAt: new Date().toISOString() })).toBe(1);
    expect(await runOnce({ outcome: "reject_and_exit", decidedAt: new Date().toISOString() })).toBe(1);
  });

  it("revise 不终止,loop 继续进下一步", async () => {
    expect(
      await runOnce({ outcome: "revise", feedback: "改", decidedAt: new Date().toISOString() })
    ).toBe(2);
  });
});
