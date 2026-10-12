import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase,
} from "../../../apps/server/src/db/index.js";
import {
  ApprovalGateway,
  ApprovalPolicyStore,
  ApprovalRepository,
} from "../../../apps/server/src/modules/approvals/index.js";
import {
  createExitPlanModeTool,
  createPlanGateState,
  type PlanGateHandle,
  type PlanGateStore,
} from "../../../packages/harness/src/index.js";
import type { PlanReviewDecision, RunStreamEvent } from "@eva/shared";

import { DrizzleSessionRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { createRunPermissions, type RunPermissions } from "../../../apps/server/src/modules/runs/index.js";
import { runToolText } from "../../helpers/run-tool.js";

/**
 * 权限链测试:驱动 createRunPermissions().canUseTool。
 * 五分支文案逐字保留自 harness 时代的 plan-review-protocol.test,
 * plan gate 拦写保留自 plan-gate.test 的 withPlanGate 用例。
 */

const handle: PlanGateHandle = {
  planId: "p1",
  planPath: "/repo/.eva/plan-gate/p1/current.md",
  planRelPath: ".eva/plan-gate/p1/current.md"
};

interface Fixture {
  readonly permissions: RunPermissions;
  readonly approvals: ApprovalGateway;
  readonly frames: RunStreamEvent[];
  readonly state: ReturnType<typeof createPlanGateState>;
  readonly store: PlanGateStore;
  readonly use: (
    toolName: string,
    input: Record<string, unknown>,
    toolUseID?: string,
  ) => Promise<Awaited<ReturnType<RunPermissions["canUseTool"]>>>;
}

const makeFixture = (
  db: AppDatabase,
  options: { readonly activePlan?: boolean; readonly planContent?: string } = {},
): Fixture => {
  const approvals = new ApprovalGateway(new ApprovalRepository(db));
  const approvalPolicies = new ApprovalPolicyStore(db, loadConfig({ env: {}, cwd: "/tmp" }));
  const frames: RunStreamEvent[] = [];
  const state = createPlanGateState(
    options.activePlan
      ? { active: true, planId: handle.planId, planPath: handle.planPath, planRelPath: handle.planRelPath }
      : { active: false },
  );
  const store: PlanGateStore = {
    enter: vi.fn(async () => handle),
    readPlan: vi.fn(async () => options.planContent ?? "# Plan"),
    recordRevision: vi.fn(async () => 3),
    approve: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
  };
  const permissions = createRunPermissions({
    approvals,
    approvalPolicies,
    runId: "run-1",
    sessionId: "session-1",
    emit: (frame) => frames.push(frame),
    planGate: { state, store },
  });
  return {
    permissions,
    approvals,
    frames,
    state,
    store,
    use: (toolName, input, toolUseID = "tc-1") =>
      permissions.canUseTool(toolName, input, {
        signal: new AbortController().signal,
        toolUseID,
      }),
  };
};

/** plan_review 的 ask 永远等人:这个助手让「决策线程」与 use 并发。 */
const withPlanReviewDecision = async <T>(
  fx: Fixture,
  toolUseID: string,
  decision: Omit<PlanReviewDecision, "decidedAt"> & { decidedAt?: string },
  use: () => Promise<T>,
): Promise<T> => {
  const pending = use();
  const timer = setTimeout(() => {
    fx.approvals.decidePlanReview(toolUseID, decision);
  }, 10);
  const result = await pending;
  clearTimeout(timer);
  return result;
};

describe("plan review 五分支(exit_plan_mode)", () => {
  let db: AppDatabase;
  it("approve + selectedLabel:allow + updatedInput.decision(审批帧先 request 后 resolved)", async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const fx = makeFixture(db, { activePlan: true });
    const result = await withPlanReviewDecision(
      fx, "tc-review",
      { outcome: "approve", selectedLabel: "方案 B" },
      () => fx.use("exit_plan_mode", {
        options: [
          { label: "方案 A", description: "" },
          { label: "方案 B", description: "" },
        ],
      }, "tc-review"),
    );

    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        decision: {
          outcome: "approve",
          selectedLabel: "方案 B",
          decidedAt: expect.any(String),
        },
      },
    });
    const request = fx.frames.find((f) => f.type === "plan_review_request");
    expect(request).toMatchObject({ type: "plan_review_request", planId: handle.planId, revision: 3 });
    expect(fx.frames.some((f) => f.type === "plan_review_resolved")).toBe(true);
    closeDb(db);
  });

  it("revise:deny 不 interrupt,message 原文回灌(文案逐字保留)", async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const fx = makeFixture(db, { activePlan: true });
    const result = await withPlanReviewDecision(
      fx, "tc-review",
      { outcome: "revise", feedback: "别动 DB 层" },
      () => fx.use("exit_plan_mode", {}, "tc-review"),
    );
    expect(result).toEqual({
      behavior: "deny",
      message: "User rejected the plan. Feedback:\n\n别动 DB 层\n\nRevise the plan and call exit_plan_mode again.",
    });
    // 闸门保持 + 不落 approve。
    expect(fx.state.current().active).toBe(true);
    expect(fx.store.approve).not.toHaveBeenCalled();
    closeDb(db);
  });

  it("reject:deny + interrupt + isError(文案逐字保留,Error: 前缀由 harness 拼)", async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const fx = makeFixture(db, { activePlan: true });
    const result = await withPlanReviewDecision(
      fx, "tc-review",
      { outcome: "reject", feedback: "太激进了" },
      () => fx.use("exit_plan_mode", {}, "tc-review"),
    );
    expect(result).toEqual({
      behavior: "deny",
      message: "Plan rejected. Plan mode remains active.\n\n太激进了",
      interrupt: true,
      isError: true,
    });
    expect(fx.state.current().active).toBe(true);
    closeDb(db);
  });

  it("reject_and_exit:deny + interrupt + isError(文案逐字保留)", async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const fx = makeFixture(db, { activePlan: true });
    const result = await withPlanReviewDecision(
      fx, "tc-review",
      { outcome: "reject_and_exit" },
      () => fx.use("exit_plan_mode", {}, "tc-review"),
    );
    expect(result).toEqual({
      behavior: "deny",
      message: "Plan rejected by user. Plan mode deactivated.",
      interrupt: true,
      isError: true,
    });
    // 落 rejected + 解闸由 exit_plan_mode 的 execute 做(allow 才进 execute;
    // reject_and_exit 的落库在 server 侧 store.reject —— 由 canUseTool 之后的
    // 哪一步做?这里只验证权限链的输出形状)。
    closeDb(db);
  });

  it("dismissed:deny 不 interrupt(文案逐字保留)", async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const fx = makeFixture(db, { activePlan: true });
    const result = await withPlanReviewDecision(
      fx, "tc-review",
      { outcome: "dismissed" },
      () => fx.use("exit_plan_mode", {}, "tc-review"),
    );
    expect(result).toEqual({
      behavior: "deny",
      message: "Plan approval dismissed. Plan mode remains active.",
    });
    expect(fx.state.current().active).toBe(true);
    closeDb(db);
  });

  it("空 plan 不弹审批卡:前置校验直接 deny(文案逐字保留)", async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const fx = makeFixture(db, { activePlan: true, planContent: "   " });
    const result = await fx.use("exit_plan_mode", {}, "tc-empty");
    expect(result).toEqual({
      behavior: "deny",
      message: `Error: No plan content found. Write your plan to ${handle.planPath} first, then call exit_plan_mode.`,
      isError: true,
    });
    // 没发审批帧,也没进 askPlanReview。
    expect(fx.frames.some((f) => f.type === "plan_review_request")).toBe(false);
    closeDb(db);
  });

  it("plan 未激活:直接 deny(文案逐字保留)", async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const fx = makeFixture(db, { activePlan: false });
    const result = await fx.use("exit_plan_mode", {}, "tc-inactive");
    expect(result).toEqual({
      behavior: "deny",
      message: "Error: exit_plan_mode can only be called while plan mode is active.",
      isError: true,
    });
    closeDb(db);
  });
});

describe("plan gate 拦写(非 plan 路径的 write/edit)", () => {
  let db: AppDatabase;
  it("active 时拦非 plan 路径,plan 路径走 ④ 直放(免弹窗,reason=plan-file)", async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const fx = makeFixture(db, { activePlan: true });

    const denied = await fx.use("write", { path: "src/a.ts", content: "x" }, "tc-w1");
    expect(denied).toEqual({
      behavior: "deny",
      message: `[Plan Mode] Only read-only tools and the current plan file are available. Write the plan to ${handle.planPath}, then call exit_plan_mode.`,
    });

    const allowed = await fx.use("write", { path: handle.planRelPath, content: "# plan" }, "tc-w2");
    expect(allowed).toEqual({ behavior: "allow" });
    // 台账:plan 文件写 autoApprove(reason=plan-file)。
    const row = fx.approvals.getRequest("tc-w2");
    expect(row?.status).toBe("granted");
    expect(row?.reason).toBe("plan-file");
    closeDb(db);
  });

  it("inactive 时全部直放 bash 只读 ③;非只读 bash 进 ⑥ 弹窗", async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const fx = makeFixture(db, { activePlan: false });

    const readonlyBash = await fx.use("bash", { command: "ls -la", description: "list" }, "tc-b1");
    expect(readonlyBash).toEqual({ behavior: "allow" });
    expect(fx.approvals.getRequest("tc-b1")?.reason).toBe("readonly-safe");

    // 非只读命令弹窗;ask 永远等人 —— 决策线程并发。
    const pending = fx.use("bash", { command: "ls > out.txt", description: "redirect" }, "tc-b2");
    setTimeout(() => {
      fx.approvals.decide("tc-b2", false);
    }, 10);
    const denied = await pending;
    expect(denied).toEqual({
      behavior: "deny",
      message:
        "[Approval Denied] The user rejected the `bash` call. "
        + "Do not retry the same call. Explain what you wanted to do and ask the user how to proceed.",
    });
    // approval_request → approval_resolved 两帧都发了。
    expect(fx.frames.some((f) => f.type === "approval_request")).toBe(true);
    expect(fx.frames.some((f) => f.type === "approval_resolved")).toBe(true);
    closeDb(db);
  });
});

describe("exit_plan_mode execute 只剩 approve 分支(工具侧)", () => {
  it("canUseTool allow + decision 注入 → execute 落库解闸,文案逐字保留", async () => {
    const db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const fx = makeFixture(db, { activePlan: true });
    const result = await withPlanReviewDecision(
      fx, "tc-exit",
      { outcome: "approve" },
      () => fx.use("exit_plan_mode", {}, "tc-exit"),
    );
    expect(result.behavior).toBe("allow");
    if (result.behavior !== "allow") throw new Error("unreachable");
    // updatedInput 注入 decision;exit_plan_mode 的 execute 用它落库解闸。
    const exitTool = createExitPlanModeTool(fx.store, fx.state);
    const out = await runToolText(exitTool, {
      decision: result.updatedInput?.decision,
    }, { toolUseID: "tc-exit" });
    expect(out).toContain("Plan approved (revision v3). Plan mode deactivated.");
    expect(fx.state.current().active).toBe(false);
    closeDb(db);
  });
});
