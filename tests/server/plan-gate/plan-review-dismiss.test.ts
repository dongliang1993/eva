import { afterEach, describe, expect, it } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { ApprovalRepository } from "../../../apps/server/src/db/repositories/approval-repository.js";
import { ApprovalGateway } from "../../../apps/server/src/services/approval-gateway.js";

let db: AppDatabase | undefined;

afterEach(() => {
  if (db) closeDb(db);
  db = undefined;
});

const setup = () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  const repo = new ApprovalRepository(db);
  return { repo, gateway: new ApprovalGateway(repo) };
};

describe("plan review dismissed 分流", () => {
  it("cancelByRun:tool pending 仍 denied,plan_review pending 落 dismissed", async () => {
    const { repo, gateway } = setup();

    const toolPromise = gateway.ask("call-tool", {
      runId: "r1",
      sessionId: "s1",
      tool: "write",
      args: { path: "src/a.ts" }
    });
    const reviewPromise = gateway.askPlanReview("call-review", {
      runId: "r1",
      sessionId: "s1",
      tool: "exit_plan_mode",
      args: { planId: "p1", planPath: "/repo/.eva/plan-gate/p1/current.md", revision: 1 }
    });

    expect(gateway.cancelByRun("r1")).toBe(2);
    expect(await toolPromise).toBe(false);

    const decision = await reviewPromise;
    expect(decision.outcome).toBe("dismissed");
    expect(repo.getById("call-tool")?.status).toBe("denied");
    expect(repo.getById("call-review")?.status).toBe("dismissed");
    expect(repo.getById("call-review")?.decision).toContain("dismissed");
  });

  it("启动清扫 failStalePending 同样按 kind 分流", () => {
    const { repo } = setup();

    repo.create({ id: "t1", sessionId: "s1", runId: "r1", tool: "write", args: {}, kind: "tool" });
    repo.create({
      id: "p1",
      sessionId: "s1",
      runId: "r1",
      tool: "exit_plan_mode",
      args: {},
      kind: "plan_review"
    });

    expect(repo.failStalePending()).toBe(2);
    expect(repo.getById("t1")?.status).toBe("denied");
    expect(repo.getById("p1")?.status).toBe("dismissed");
  });

  it("decidePlanReview:revise 必须带 feedback;approve 校验 selectedLabel 在 options 内", async () => {
    const { gateway } = setup();

    const revisePromise = gateway.askPlanReview("call-revise", {
      runId: "r1",
      sessionId: "s1",
      tool: "exit_plan_mode",
      args: { planId: "p1", planPath: "/p", revision: 1 }
    });
    expect(gateway.decidePlanReview("call-revise", { outcome: "revise" })).toBe(false);
    expect(gateway.decidePlanReview("call-revise", { outcome: "revise", feedback: "改" })).toBe(true);
    expect((await revisePromise).outcome).toBe("revise");

    const approvePromise = gateway.askPlanReview("call-approve", {
      runId: "r1",
      sessionId: "s1",
      tool: "exit_plan_mode",
      args: {
        planId: "p1",
        planPath: "/p",
        revision: 2,
        options: [{ label: "A", description: "" }, { label: "B", description: "" }]
      }
    });
    expect(
      gateway.decidePlanReview("call-approve", { outcome: "approve", selectedLabel: "C" })
    ).toBe(false);
    expect(
      gateway.decidePlanReview("call-approve", { outcome: "approve", selectedLabel: "B" })
    ).toBe(true);
    expect((await approvePromise).selectedLabel).toBe("B");
  });
});
