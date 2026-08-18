import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { DrizzleRunRepository } from "../apps/server/src/db/repositories/run-repository.js";
import { DrizzleSessionRepository } from "../apps/server/src/db/repositories/session-repository.js";
import { ApprovalRepository } from "../apps/server/src/db/repositories/approval-repository.js";
import { ApprovalGateway } from "../apps/server/src/services/approval-gateway.js";
import {
  deriveSessionStatus,
  readSessionRuntimeStatus
} from "../apps/server/src/services/session-status.js";

describe("deriveSessionStatus", () => {
  it("两个 true 时取 requires_action(等人 > 在跑)", () => {
    expect(
      deriveSessionStatus({ hasPendingApproval: true, hasRunningRun: true })
    ).toBe("requires_action");
  });

  it("只有 run 在跑取 running", () => {
    expect(
      deriveSessionStatus({ hasPendingApproval: false, hasRunningRun: true })
    ).toBe("running");
  });

  it("都没有取 idle", () => {
    expect(
      deriveSessionStatus({ hasPendingApproval: false, hasRunningRun: false })
    ).toBe("idle");
  });

  it("审批优先级高于 run", () => {
    expect(
      deriveSessionStatus({ hasPendingApproval: true, hasRunningRun: false })
    ).toBe("requires_action");
  });
});

describe("readSessionRuntimeStatus", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("空闲会话 → idle,activeRunId null", () => {
    const sessionRepo = new DrizzleSessionRepository(db);
    const session = sessionRepo.create({ id: "s-1" });
    const approvals = new ApprovalGateway(new ApprovalRepository(db));

    const status = readSessionRuntimeStatus(db, approvals, session.id);
    expect(status.status).toBe("idle");
    expect(status.activeRunId).toBeNull();
    expect(status.pendingApprovals).toEqual([]);
  });

  it("有 pending 审批 → requires_action 且带审批摘要", () => {
    const approvals = new ApprovalGateway(new ApprovalRepository(db));
    approvals.ask("c1", { runId: "r-1", sessionId: "s-1", tool: "bash", args: { command: "x" } });

    const status = readSessionRuntimeStatus(db, approvals, "s-1");
    expect(status.status).toBe("requires_action");
    expect(status.pendingApprovals).toEqual([
      { callId: "c1", toolName: "bash", args: { command: "x" } }
    ]);

    // 收尾 timer
    approvals.cancelByRun("r-1");
  });

  it("有 running run → running 且 activeRunId 指向它", () => {
    new DrizzleSessionRepository(db).create({ id: "s-2" });
    new DrizzleRunRepository(db).start({
      id: "r-2",
      sessionId: "s-2",
      model: "openai:test",
      userMessageId: "um-1"
    });
    const approvals = new ApprovalGateway(new ApprovalRepository(db));

    const status = readSessionRuntimeStatus(db, approvals, "s-2");
    expect(status.status).toBe("running");
    expect(status.activeRunId).toBe("r-2");
  });
});