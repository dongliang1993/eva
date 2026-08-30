import { describe, expect, it, vi } from "vitest";

import {
  createPlanWeaveTools,
  withApproval,
  type AgentTool,
  type PlanWeaveGateway
} from "../../../packages/harness/src/tools/index.js";

const makeGateway = (): PlanWeaveGateway => ({
  create: vi.fn(async () => "created"),
  status: vi.fn(async () => "status"),
  claim: vi.fn(async () => "packet"),
  submit: vi.fn(async () => "submitted"),
  review: vi.fn(async () => "reviewed"),
  resolve: vi.fn(async () => "resolved")
});

const call = (tool: AgentTool, input: unknown): Promise<string> =>
  tool.tool.execute!(input as never, { toolCallId: "tc" } as never) as Promise<string>;

const VALID_PLAN = {
  title: "Ship",
  goal: "goal",
  tasks: [
    {
      id: "T1",
      title: "task",
      blocks: [
        { id: "B1", title: "b", instructions: "do it", acceptance: "it done" }
      ]
    }
  ]
};

const validInputs: Record<string, unknown> = {
  plan_create: { plan: VALID_PLAN },
  plan_status: {},
  plan_claim: {},
  plan_submit: { ref: "T1:B1", report: "report" },
  plan_review: { ref: "T1:B1", verdict: "approved" },
  plan_resolve: { feedbackId: "FB-1", resolution: "fixed" }
};

describe("plan-weave 内置工具", () => {
  it("六个工具,名字齐全", () => {
    const tools = createPlanWeaveTools(makeGateway());
    expect(tools.map((t) => t.name).sort()).toEqual([
      "plan_claim",
      "plan_create",
      "plan_resolve",
      "plan_review",
      "plan_status",
      "plan_submit"
    ]);
  });

  it("都不触发审批(needsApproval 未设,withApproval 直通)", async () => {
    const gateway = makeGateway();
    const tools = createPlanWeaveTools(gateway);
    const ask = vi.fn(async () => true);

    for (const tool of tools) {
      expect(tool.needsApproval).not.toBe(true);
      const wrapped = withApproval(tool, ask);
      const out = await call(wrapped, validInputs[tool.name]!);
      expect(out).not.toContain("Error:");
    }
    expect(ask).not.toHaveBeenCalled();
    expect(gateway.create).toHaveBeenCalledOnce();
    expect(gateway.claim).toHaveBeenCalledOnce();
  });

  it("只有 plan_status 是 readOnly", () => {
    const tools = createPlanWeaveTools(makeGateway());
    for (const tool of tools) {
      if (tool.name === "plan_status") {
        expect(tool.readOnly).toBe(true);
      } else {
        expect(tool.readOnly).not.toBe(true);
      }
    }
  });

  it("入参塞路径字段被 strict schema 拒掉,gateway 不被调用", async () => {
    const gateway = makeGateway();
    const tools = createPlanWeaveTools(makeGateway());
    const byName = new Map(tools.map((t) => [t.name, t]));

    const submit = await call(byName.get("plan_submit")!, {
      ref: "T1:B1",
      report: "x",
      path: "/tmp/evil"
    });
    expect(submit).toContain("Error:");
    expect(gateway.submit).not.toHaveBeenCalled();

    const status = await call(byName.get("plan_status")!, { dir: "/tmp/evil" });
    expect(status).toContain("Error:");
    expect(gateway.status).not.toHaveBeenCalled();

    const create = await call(byName.get("plan_create")!, {
      plan: VALID_PLAN,
      workspace: "/tmp/evil"
    });
    expect(create).toContain("Error:");
    expect(gateway.create).not.toHaveBeenCalled();
  });

  it("plan_create 透传 schema 默认值(deps/maxReviewCycles)", async () => {
    const gateway = makeGateway();
    const tools = createPlanWeaveTools(gateway);
    const create = tools.find((t) => t.name === "plan_create")!;

    await call(create, { plan: VALID_PLAN });
    expect(gateway.create).toHaveBeenCalledWith({
      title: "Ship",
      goal: "goal",
      tasks: [
        {
          id: "T1",
          title: "task",
          blocks: [
            {
              id: "B1",
              title: "b",
              instructions: "do it",
              acceptance: "it done",
              deps: [],
              maxReviewCycles: 3
            }
          ]
        }
      ]
    });
  });

  it("needs_changes 不带 notes 也能到 gateway(业务校验在 service)", async () => {
    const gateway = makeGateway();
    const tools = createPlanWeaveTools(gateway);
    const review = tools.find((t) => t.name === "plan_review")!;

    await call(review, { ref: "T1:B1", verdict: "needs_changes" });
    expect(gateway.review).toHaveBeenCalledWith("T1:B1", "needs_changes", undefined);
  });
});
