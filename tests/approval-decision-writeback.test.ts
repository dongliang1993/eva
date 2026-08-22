import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isDynamicToolPart, createUserUIMessage } from "../packages/shared/src/index.js";
import type { ApprovalDecision } from "../packages/shared/src/index.js";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { DrizzleSessionRepository } from "../apps/server/src/db/repositories/session-repository.js";
import { DrizzleMessageRepository } from "../apps/server/src/db/repositories/message-repository.js";
import { ApprovalRepository } from "../apps/server/src/db/repositories/approval-repository.js";
import { SessionService } from "../apps/server/src/services/session.js";
import { ApprovalGateway } from "../apps/server/src/services/approval-gateway.js";
import { AssistantMessageRecorder } from "../apps/server/src/services/runs/assistant-message-recorder.js";

/**
 * T30:审批决策回写消息 part(docs/plans/r7/T30)。
 * decide 时消息还在在飞 builder、拿不到;写入点必须选在 finish 落库前查回写
 * (§1.2 时序约束)。事实源是 approval_requests 行,不是 SSE 事件(§坑 3)。
 */
describe("T30 决策回写消息 part", () => {
  let db: AppDatabase;
  let session: SessionService;
  let messageRepo: DrizzleMessageRepository;
  let approvalRepo: ApprovalRepository;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    session = new SessionService(new DrizzleSessionRepository(db), new DrizzleMessageRepository(db));
    messageRepo = new DrizzleMessageRepository(db);
    approvalRepo = new ApprovalRepository(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  const lookupDecision = (callId: string): ApprovalDecision | undefined => {
    const row = approvalRepo.getById(callId);
    if (!row || row.status === "pending" || !row.decidedAt) return undefined;
    return { action: row.status, decidedAt: row.decidedAt };
  };

  /** 造一条带 dynamic-tool part 的在飞 assistant 消息并 finish 落库。 */
  const recordRunWithTool = (callId: string): string => {
    const { session: s } = session.createSession(createUserUIMessage(randomUUID(), "run bash"));
    const recorder = new AssistantMessageRecorder(session, {
      sessionId: s.id,
      runId: "run-1",
      model: "p:m",
      initialPosition: session.positionAfterActiveLeaf(s.id),
      lookupDecision
    });

    recorder.push({ type: "tool-call", toolCallId: callId, toolName: "bash", args: { command: "rm x" } });
    recorder.push({ type: "tool-result", toolCallId: callId, output: "done", status: "ok" });
    recorder.push({ type: "finish", finishReason: "stop" });
    recorder.finish();
    return s.id;
  };

  it("决策后 finish 落库的 part 带 approvalDecision(RED-1)", () => {
    // 决策先于 finish(真实时序:用户点完审批,run 收尾才落库消息)。
    approvalRepo.create({ id: "tc-1", sessionId: "s", runId: "run-1", tool: "bash", args: {} });
    approvalRepo.decide("tc-1", "granted");

    const sessionId = recordRunWithTool("tc-1");

    const messages = messageRepo.findBySessionId(sessionId);
    const assistant = messages.find((m) => m.role === "assistant")!;
    const toolPart = assistant.message.parts.find(isDynamicToolPart)!;
    expect(toolPart.toolMetadata?.approvalDecision).toEqual({
      action: "granted",
      decidedAt: approvalRepo.getById("tc-1")!.decidedAt
    });
  });

  it("cancelByRun 收 denied 也回写,不开单独路径(RED-3)", () => {
    const gateway = new ApprovalGateway(approvalRepo);
    const { session: s } = session.createSession(createUserUIMessage(randomUUID(), "run bash"));

    // 审批先 pending(消息在飞),用户点停止 → cancelByRun 收 denied。
    void gateway.ask("tc-2", { runId: "run-1", sessionId: s.id, tool: "bash", args: {} });
    gateway.cancelByRun("run-1");

    const recorder = new AssistantMessageRecorder(session, {
      sessionId: s.id,
      runId: "run-1",
      model: "p:m",
      initialPosition: session.positionAfterActiveLeaf(s.id),
      lookupDecision
    });
    recorder.push({ type: "tool-call", toolCallId: "tc-2", toolName: "bash", args: { command: "rm x" } });
    recorder.push({ type: "tool-result", toolCallId: "tc-2", output: "denied", status: "ok" });
    recorder.push({ type: "finish", finishReason: "aborted" });
    recorder.finish();

    const messages = messageRepo.findBySessionId(s.id);
    const assistant = messages.find((m) => m.role === "assistant")!;
    const toolPart = assistant.message.parts.find(isDynamicToolPart)!;
    expect(toolPart.toolMetadata?.approvalDecision).toMatchObject({ action: "denied" });
  });

  it("查不到决策行(或仍 pending)的 part 不写 approvalDecision", () => {
    const sessionId = recordRunWithTool("tc-no-row");

    const messages = messageRepo.findBySessionId(sessionId);
    const assistant = messages.find((m) => m.role === "assistant")!;
    const toolPart = assistant.message.parts.find(isDynamicToolPart)!;
    expect(toolPart.toolMetadata?.approvalDecision).toBeUndefined();
  });

  it("runs.ts 的 approval_resolved 帧带 decision 且与台账同源(RED-2,钉接线)", () => {
    // 摘掉 decision payload 或换成「拍脑袋 new Date()」都会让前端定格态与台账漂移。
    // 钉死两件事:① 帧里查的是 approvals.getRequest(台账),不是现造时间;
    // ② decision 字段真实存在于 emit payload。
    const source = readFileSync(
      new URL("../apps/server/src/routes/runs.ts", import.meta.url),
      "utf8"
    );
    const resolvedFrame = source.slice(source.indexOf('type: "approval_resolved"'));
    expect(resolvedFrame).toContain("decision: lookupApprovalDecision(toolCallId)");
    expect(source).toContain("app.services.approvals.getRequest(callId)");
  });
});
