import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { ApprovalRepository } from "../apps/server/src/db/repositories/approval-repository.js";
import { ApprovalGateway } from "../apps/server/src/services/approval-gateway.js";
import { RunRegistry } from "../apps/server/src/services/run-registry.js";

describe("abort 与 pending 审批", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("审批挂起时 abort → 审批立刻按拒绝返回,不等超时", async () => {
    const registry = new RunRegistry();
    const approvals = new ApprovalGateway(new ApprovalRepository(db));
    const runId = "run-1";

    registry.register(runId);
    // 会话是 run 跑起来之后才知道的 —— 这正是旧设计糊不住的地方
    const asked = approvals.ask("call-1", {
      runId,
      sessionId: "session-1",
      tool: "bash",
      args: {}
    });

    expect(registry.abort(runId)).toBe(true);
    approvals.cancelByRun(runId);

    await expect(asked).resolves.toBe(false);
    expect(new ApprovalRepository(db).getById("call-1")?.status).toBe("denied");
  });

  it("listPending 只返回指定会话的待审批", () => {
    const approvals = new ApprovalGateway(new ApprovalRepository(db));

    approvals.ask("call-a", { runId: "run-a", sessionId: "session-a", tool: "bash", args: {} });
    approvals.ask("call-b", { runId: "run-b", sessionId: "session-b", tool: "bash", args: {} });

    expect(approvals.listPending("session-a").map((p) => p.callId)).toEqual(["call-a"]);
    expect(approvals.listPending("session-b").map((p) => p.callId)).toEqual(["call-b"]);

    // 收尾:两条 ask 的 5 分钟 timer 不清掉会挂住 vitest 进程
    approvals.cancelByRun("run-a");
    approvals.cancelByRun("run-b");
  });
});