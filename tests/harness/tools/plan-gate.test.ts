import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createPlanGateState,
  planGateInstructions,
  withPlanGate,
  type AgentTool,
  type PlanGateStore
} from "../../../packages/harness/src/tools/index.js";

const probe = (
  name: string,
  execute: (input: unknown) => Promise<string> | string,
  options: { readOnly?: boolean; needsApproval?: boolean } = {}
): AgentTool =>
  buildTool({
    name,
    description: `probe ${name}`,
    inputSchema: z.object({ path: z.string().optional() }).passthrough(),
    execute: async (input) => execute(input),
    ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
    ...(options.needsApproval !== undefined
      ? { needsApproval: options.needsApproval }
      : {})
  });

const call = (tool: AgentTool, input: unknown): Promise<string> =>
  tool.tool.execute!(input as never, { toolCallId: "tc" } as never) as Promise<string>;

describe("withPlanGate", () => {
  const plan = {
    planId: "p1",
    planPath: "/repo/.eva/plan-gate/p1/current.md",
    planRelPath: ".eva/plan-gate/p1/current.md"
  };

  it("inactive 时全部直放", async () => {
    const state = createPlanGateState({ active: false });
    const inner = vi.fn(async () => "ok");
    const tool = withPlanGate(probe("write", inner), state);

    expect(await call(tool, { path: "src/a.ts" })).toBe("ok");
    expect(inner).toHaveBeenCalledOnce();
  });

  it("active 时只挡 write/edit 到非 plan 路径与硬挡名单", async () => {
    const state = createPlanGateState({ active: false });
    state.enter(plan);

    const writeInner = vi.fn(async () => "wrote");
    const write = withPlanGate(probe("write", writeInner), state);

    const denied = await call(write, { path: "src/a.ts" });
    expect(denied).toContain("[Plan Mode]");
    expect(writeInner).not.toHaveBeenCalled();

    expect(await call(write, { path: plan.planRelPath })).toBe("wrote");
    expect(await call(write, { path: plan.planPath })).toBe("wrote");

    const readInner = vi.fn(async () => "read");
    expect(await call(withPlanGate(probe("read_file", readInner, { readOnly: true }), state), {})).toBe("read");

    const bashInner = vi.fn(async () => "bash");
    expect(await call(withPlanGate(probe("bash", bashInner), state), {})).toBe("bash");

    const stopInner = vi.fn(async () => "stop");
    expect(await call(withPlanGate(probe("TaskStop", stopInner), state), {})).toContain("[Plan Mode]");
    expect(stopInner).not.toHaveBeenCalled();
  });

  it("state 是 execute 期 getter:exit 后同一包装工具立刻放行", async () => {
    const state = createPlanGateState({ active: false });
    state.enter(plan);
    const inner = vi.fn(async () => "ok");
    const tool = withPlanGate(probe("write", inner), state);

    expect(await call(tool, { path: "src/a.ts" })).toContain("[Plan Mode]");
    state.exit();
    expect(await call(tool, { path: "src/a.ts" })).toBe("ok");
  });
});

describe("enter/exit_plan_mode", () => {
  const makeStore = (planContent: string) => {
    const handle = {
      planId: "p1",
      planPath: "/repo/.eva/plan-gate/p1/current.md",
      planRelPath: ".eva/plan-gate/p1/current.md"
    };
    const store: PlanGateStore = {
      enter: vi.fn(async () => handle),
      readPlan: vi.fn(async () => planContent),
      recordRevision: vi.fn(async () => 1),
      approve: vi.fn(async () => undefined)
    };
    return { handle, store };
  };

  it("enter 改 state 并返回 plan 路径；重复 enter 报错", async () => {
    const state = createPlanGateState({ active: false });
    const { store } = makeStore("plan");
    const enter = createEnterPlanModeTool(store, state);

    const out = await call(enter, {});
    expect(out).toContain("Plan mode is now active.");
    expect(out).toContain("/repo/.eva/plan-gate/p1/current.md");
    expect(state.current().active).toBe(true);

    expect(await call(enter, {})).toContain("already active");
  });

  it("空 plan 不能 exit；非空 plan exit 定版并解闸", async () => {
    const state = createPlanGateState({ active: false });
    const { store } = makeStore("");
    const enter = createEnterPlanModeTool(store, state);
    const exit = createExitPlanModeTool(store, state);

    await call(enter, {});
    expect(await call(exit, {})).toContain("No plan content");

    (store.readPlan as ReturnType<typeof vi.fn>).mockResolvedValue("# Plan");
    const approved = await call(exit, {});
    expect(approved).toContain("Plan approved (revision v1)");
    expect(store.recordRevision).toHaveBeenCalledOnce();
    expect(store.approve).toHaveBeenCalledOnce();
    expect(state.current().active).toBe(false);
  });

  it("plan active 时每步 reminder 带 plan 路径", () => {
    const instructions = planGateInstructions({
      active: true,
      planPath: "/repo/.eva/plan-gate/p1/current.md"
    });

    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.content).toContain("/repo/.eva/plan-gate/p1/current.md");
    expect(planGateInstructions({ active: false })).toEqual([]);
  });
});
