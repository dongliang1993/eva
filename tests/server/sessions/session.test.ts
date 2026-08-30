import { randomUUID } from "node:crypto";

import { convertToModelMessages } from "ai";
import { describe, expect, it, beforeEach } from "vitest";

import {
  createUserUIMessage,
  uiMessageText,
  type EvaUIMessage
} from "../../../packages/shared/src/index.js";

import { initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/db/repositories/session-repository.js";
import { DrizzleMessageRepository } from "../../../apps/server/src/db/repositories/message-repository.js";
import { SessionService } from "../../../apps/server/src/services/session.js";

let db: AppDatabase;
let sessionRepo: DrizzleSessionRepository;
let messageRepo: DrizzleMessageRepository;
let service: SessionService;

const assistantMessage = (
  parts: EvaUIMessage["parts"]
): EvaUIMessage => ({
  id: randomUUID(),
  role: "assistant",
  parts
});

const userMessage = (text: string): EvaUIMessage =>
  createUserUIMessage(randomUUID(), text);

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  sessionRepo = new DrizzleSessionRepository(db);
  messageRepo = new DrizzleMessageRepository(db);
  service = new SessionService(sessionRepo, messageRepo);
});

// ---------------------------------------------------------------------------
// Session Repository
// ---------------------------------------------------------------------------

describe("DrizzleSessionRepository", () => {
  it("creates and retrieves a session", () => {
    const session = sessionRepo.create({
      id: randomUUID(),
      title: "Test Session"
    });

    expect(session.title).toBe("Test Session");

    const found = sessionRepo.findById(session.id);

    expect(found).toBeDefined();
    expect(found!.id).toBe(session.id);
  });

  it("updates timestamp", () => {
    const session = sessionRepo.create({ id: randomUUID() });

    const before = sessionRepo.findById(session.id)!.updatedAt;

    sessionRepo.updateTimestamp(session.id);

    const after = sessionRepo.findById(session.id)!.updatedAt;

    expect(after >= before).toBe(true);
  });

  it("deletes a session", () => {
    const session = sessionRepo.create({ id: randomUUID() });

    expect(sessionRepo.deleteById(session.id)).toBe(true);
    expect(sessionRepo.findById(session.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Message Repository
// ---------------------------------------------------------------------------

describe("DrizzleMessageRepository", () => {
  it("creates and retrieves messages", () => {
    const session = sessionRepo.create({ id: randomUUID() });

    messageRepo.create({ sessionId: session.id, message: userMessage("Hello") });
    messageRepo.create({
      sessionId: session.id,
      message: assistantMessage([{ type: "text", text: "Hi there", state: "done" }])
    });

    const messages = messageRepo.findBySessionId(session.id);

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    expect(uiMessageText(messages[1]!.message)).toBe("Hi there");
  });

  it("respects limit", () => {
    const session = sessionRepo.create({ id: randomUUID() });

    for (let i = 0; i < 5; i++) {
      messageRepo.create({ sessionId: session.id, message: userMessage(`Message ${i}`) });
    }

    const messages = messageRepo.findBySessionId(session.id, { limit: 3 });

    expect(messages).toHaveLength(3);
  });

  it("cascade deletes messages when session is deleted", () => {
    const session = sessionRepo.create({ id: randomUUID() });

    messageRepo.create({ sessionId: session.id, message: userMessage("Will be deleted") });

    sessionRepo.deleteById(session.id);

    const messages = messageRepo.findBySessionId(session.id);

    expect(messages).toHaveLength(0);
  });

  it("findLastBySessionId returns the most recent message", () => {
    const session = sessionRepo.create({ id: randomUUID() });

    messageRepo.create({ sessionId: session.id, message: userMessage("first") });
    messageRepo.create({ sessionId: session.id, message: userMessage("second") });

    const last = messageRepo.findLastBySessionId(session.id);

    expect(last).toBeDefined();
    expect(uiMessageText(last!.message)).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Session Service
// ---------------------------------------------------------------------------

describe("SessionService", () => {
  it("creates a new session", () => {
    const result = service.createSession(userMessage("Hello bot"));

    expect(result.isNew).toBe(true);
    expect(result.session.title).toBe("Hello bot");
    expect(result.userMessage.role).toBe("user");
    expect(uiMessageText(result.userMessage.message)).toBe("Hello bot");
  });

  it("continues an existing session by id", () => {
    const first = service.createSession(userMessage("First message"));

    service.recordAssistantMessage(
      first.session.id,
      assistantMessage([{ type: "text", text: "Bot reply", state: "done" }]),
      service.positionAfterActiveLeaf(first.session.id)
    );

    const second = service.continueSession(first.session.id, userMessage("Second message"));

    expect(second).toBeDefined();
    expect(second!.isNew).toBe(false);
    expect(second!.session.id).toBe(first.session.id);

    const history = service.buildModelHistory(db, first.session.id);
    expect(history.messages).toHaveLength(3);
    expect(uiMessageText(history.messages[0]!)).toBe("First message");
    expect(uiMessageText(history.messages[1]!)).toBe("Bot reply");
    expect(uiMessageText(history.messages[2]!)).toBe("Second message");
  });

  it("returns undefined for unknown session id", () => {
    expect(service.continueSession("nonexistent", userMessage("Hi"))).toBeUndefined();
  });

  it("records assistant message with tool calls as dynamic-tool parts", () => {
    const { session } = service.createSession(userMessage("Analyze issue"));

    service.recordAssistantMessage(
      session.id,
      assistantMessage([
        {
          type: "dynamic-tool",
          toolName: "sentry_analyze_issue",
          toolCallId: "tc-1",
          state: "output-available",
          input: { issueId: "123" },
          output: "NullPointerException at line 42"
        },
        { type: "text", text: "Found the bug", state: "done" }
      ]),
      service.positionAfterActiveLeaf(session.id)
    );

    const messages = messageRepo.findBySessionId(session.id);
    const assistantMsg = messages.find((m) => m.role === "assistant")!;
    const toolPart = assistantMsg.message.parts.find((p) => p.type === "dynamic-tool")!;

    expect(toolPart).toBeDefined();
    expect(toolPart.type).toBe("dynamic-tool");
    if (toolPart.type === "dynamic-tool") {
      expect(toolPart.toolName).toBe("sentry_analyze_issue");
      expect(toolPart.state).toBe("output-available");
      expect(toolPart.output).toBe("NullPointerException at line 42");
    }
    expect(uiMessageText(assistantMsg.message)).toBe("Found the bug");
  });

  it("模型历史保留上一轮的工具轨迹", async () => {
    const { session } = service.createSession(userMessage("读一下 a.ts"));

    service.recordAssistantMessage(
      session.id,
      assistantMessage([
        {
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId: "tc-1",
          state: "output-available",
          input: { path: "a.ts" },
          output: "export const x = 1;"
        },
        { type: "text", text: "读到了", state: "done" }
      ]),
      service.positionAfterActiveLeaf(session.id)
    );

    const history = service.buildModelHistory(db, session.id);
    const modelMessages = await convertToModelMessages([...history.messages], {
      ignoreIncompleteToolCalls: true
    });

    // 关键:必须出现一条 role === "tool" 的消息,且里面有工具输出
    expect(modelMessages.some((m) => m.role === "tool")).toBe(true);
    expect(JSON.stringify(modelMessages)).toContain("export const x = 1;");
  });

  it("被 abort 的消息(工具没有结果)不会让历史转换失败", async () => {
    const { session } = service.createSession(userMessage("做点事"));

    service.recordAssistantMessage(
      session.id,
      assistantMessage([
        {
          type: "dynamic-tool",
          toolName: "write_file",
          toolCallId: "tc-2",
          state: "input-available",
          input: { path: "a.ts" }
        }
      ]),
      service.positionAfterActiveLeaf(session.id)
    );

    const history = service.buildModelHistory(db, session.id);

    // ignoreIncompleteToolCalls 下不抛,且结果里没有孤儿 tool-call
    const modelMessages = await convertToModelMessages([...history.messages], {
      ignoreIncompleteToolCalls: true
    });

    expect(modelMessages.some((m) => m.role === "tool")).toBe(false);
  });

  it("records assistant message with usage metadata", () => {
    const { session } = service.createSession(userMessage("Hi"));

    const msg = service.recordAssistantMessage(
      session.id,
      {
        ...assistantMessage([{ type: "text", text: "Response", state: "done" }]),
        metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      },
      service.positionAfterActiveLeaf(session.id)
    );

    expect(msg.message.metadata?.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15
    });
  });

  it("keeps different sessions isolated", () => {
    const a = service.createSession(userMessage("Message A"));
    const b = service.createSession(userMessage("Message B"));

    const a2 = service.continueSession(a.session.id, userMessage("Follow up A"))!;
    const b2 = service.continueSession(b.session.id, userMessage("Follow up B"))!;

    expect(a2.session.id).not.toBe(b2.session.id);

    const aHistory = service.buildModelHistory(db, a.session.id);
    const bHistory = service.buildModelHistory(db, b.session.id);
    expect(aHistory.messages).toHaveLength(2);
    expect(bHistory.messages).toHaveLength(2);
  });

  it("版本树三件套按线性链写入", () => {
    const { session } = service.createSession(userMessage("first"));
    const first = messageRepo.findLastBySessionId(session.id)!;

    service.recordAssistantMessage(
      session.id,
      assistantMessage([{ type: "text", text: "reply", state: "done" }]),
      service.positionAfterActiveLeaf(session.id)
    );
    const second = messageRepo.findLastBySessionId(session.id)!;

    expect(first.parentId).toBeNull();
    expect(first.depth).toBe(0);
    expect(second.parentId).toBe(first.id);
    expect(second.depth).toBe(1);
    expect(first.slotId).toBeDefined();
    expect(second.slotId).toBeDefined();
    expect(first.slotId).not.toBe(second.slotId);
  });
});