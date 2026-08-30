import { describe, expect, it, vi } from "vitest";

import {
  createExitPlanModeTool,
  createPlanGateState,
  type PlanGateHandle,
  type PlanGateStore,
  type RequestPlanReview
} from "../../../packages/harness/src/tools/index.js";
import type { PlanReviewDecision } from "@eva/shared";

const handle: PlanGateHandle = {
  planId: "p1",
  planPath: "/repo/.eva/plan-gate/p1/current.md",
  planRelPath: ".eva/plan-gate/p1/current.md"
};

const makeStore = () => ({
  enter: vi.fn(async () => handle),
  readPlan: vi.fn(async () => "# Plan"),
  recordRevision: vi.fn(async () => 3),
  approve: vi.fn(async () => undefined),
  reject: vi.fn(async () => undefined)
});

const activeState = () => {
  const state = createPlanGateState({ active: false });
  state.enter(handle);
  return state;
};

const callExit = (
  store: PlanGateStore,
  state: ReturnType<typeof activeState>,
  requestPlanReview: RequestPlanReview,
  options?: Array<{ label: string; description: string }>
) =>
  createExitPlanModeTool(store, state, requestPlanReview).tool.execute!(
    options === undefined ? {} : { options },
    { toolCallId: "tc-review" } as never
  ) as Promise<string>;

describe("exit_plan_mode 五分支", () => {
  it("approve + selectedLabel:解闸、approve 落库、输出选中方案", async () => {
    const store = makeStore();
    const state = activeState();
    const review: RequestPlanReview = async () => ({
      outcome: "approve",
      selectedLabel: "方案 B",
      decidedAt: new Date().toISOString()
    });

    const out = await callExit(store, state, review, [
      { label: "方案 A", description: "" },
      { label: "方案 B", description: "" }
    ]);

    expect(out).toContain("Execute ONLY the selected approach");
    expect(out).toContain("方案 B");
    expect(store.approve).toHaveBeenCalledOnce();
    expect(state.current().active).toBe(false);
    expect(state.shouldStopTurn()).toBe(false);
  });

  it("revise:闸门保持、feedback 原文回灌、不终止", async () => {
    const store = makeStore();
    const state = activeState();
    const review: RequestPlanReview = async () => ({
      outcome: "revise",
      feedback: "别动 DB 层",
      decidedAt: new Date().toISOString()
    });

    const out = await callExit(store, state, review);

    expect(out).toContain("别动 DB 层");
    expect(store.approve).not.toHaveBeenCalled();
    expect(state.current().active).toBe(true);
    expect(state.shouldStopTurn()).toBe(false);
  });

  it("reject:闸门保持 + shouldStopTurn + Error 前缀", async () => {
    const store = makeStore();
    const state = activeState();
    const review: RequestPlanReview = async () => ({
      outcome: "reject",
      decidedAt: new Date().toISOString()
    });

    const out = await callExit(store, state, review);

    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("Plan mode remains active");
    expect(state.current().active).toBe(true);
    expect(state.shouldStopTurn()).toBe(true);
  });

  it("reject_and_exit:落 rejected + 解闸 + 终止", async () => {
    const store = makeStore();
    const state = activeState();
    const review: RequestPlanReview = async () => ({
      outcome: "reject_and_exit",
      decidedAt: new Date().toISOString()
    });

    const out = await callExit(store, state, review);

    expect(out).toContain("Plan mode deactivated");
    expect(store.reject).toHaveBeenCalledOnce();
    expect(state.current().active).toBe(false);
    expect(state.shouldStopTurn()).toBe(true);
  });

  it("dismissed:闸门保持、文案对齐 Kimi", async () => {
    const store = makeStore();
    const state = activeState();
    const review: RequestPlanReview = async () => ({
      outcome: "dismissed",
      decidedAt: new Date().toISOString()
    });

    const out = await callExit(store, state, review);

    expect(out).toBe("Plan approval dismissed. Plan mode remains active.");
    expect(state.current().active).toBe(true);
    expect(state.shouldStopTurn()).toBe(false);
  });
});
