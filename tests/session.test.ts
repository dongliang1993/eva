import { randomUUID } from "node:crypto";

import { describe, expect, it, beforeEach } from "vitest";

import { initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { DrizzleSessionRepository } from "../apps/server/src/db/repositories/session-repository.js";
import { DrizzleMessageRepository } from "../apps/server/src/db/repositories/message-repository.js";
import { SessionService } from "../apps/server/src/services/session.js";

let db: AppDatabase;
let sessionRepo: DrizzleSessionRepository;
let messageRepo: DrizzleMessageRepository;
let service: SessionService;

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
      sessionKey: "chat:user1",
      title: "Test Session"
    });

    expect(session.sessionKey).toBe("chat:user1");
    expect(session.title).toBe("Test Session");

    const found = sessionRepo.findById(session.id);

    expect(found).toBeDefined();
    expect(found!.id).toBe(session.id);
  });

  it("finds by session key", () => {
    sessionRepo.create({
      id: randomUUID(),
      sessionKey: "thread:abc",
      title: "Thread Chat"
    });

    const found = sessionRepo.findBySessionKey("thread:abc");

    expect(found).toBeDefined();
    expect(found!.sessionKey).toBe("thread:abc");
  });

  it("returns undefined for unknown session key", () => {
    expect(sessionRepo.findBySessionKey("nonexistent")).toBeUndefined();
  });

  it("updates timestamp", () => {
    const session = sessionRepo.create({
      id: randomUUID(),
      sessionKey: "key1"
    });

    const before = sessionRepo.findById(session.id)!.updatedAt;

    sessionRepo.updateTimestamp(session.id);

    const after = sessionRepo.findById(session.id)!.updatedAt;

    expect(after >= before).toBe(true);
  });

  it("deletes a session", () => {
    const session = sessionRepo.create({
      id: randomUUID(),
      sessionKey: "delete-me"
    });

    expect(sessionRepo.deleteById(session.id)).toBe(true);
    expect(sessionRepo.findById(session.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Message Repository
// ---------------------------------------------------------------------------

describe("DrizzleMessageRepository", () => {
  it("creates and retrieves messages", () => {
    const session = sessionRepo.create({
      id: randomUUID(),
      sessionKey: "msg-test"
    });

    messageRepo.create({
      id: randomUUID(),
      sessionId: session.id,
      role: "user",
      content: "Hello"
    });

    messageRepo.create({
      id: randomUUID(),
      sessionId: session.id,
      role: "assistant",
      content: "Hi there"
    });

    const messages = messageRepo.findBySessionId(session.id);

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
  });

  it("respects limit", () => {
    const session = sessionRepo.create({
      id: randomUUID(),
      sessionKey: "limit-test"
    });

    for (let i = 0; i < 5; i++) {
      messageRepo.create({
        id: randomUUID(),
        sessionId: session.id,
        role: "user",
        content: `Message ${i}`
      });
    }

    const messages = messageRepo.findBySessionId(session.id, { limit: 3 });

    expect(messages).toHaveLength(3);
  });

  it("cascade deletes messages when session is deleted", () => {
    const session = sessionRepo.create({
      id: randomUUID(),
      sessionKey: "cascade-test"
    });

    messageRepo.create({
      id: randomUUID(),
      sessionId: session.id,
      role: "user",
      content: "Will be deleted"
    });

    sessionRepo.deleteById(session.id);

    const messages = messageRepo.findBySessionId(session.id);

    expect(messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Session Service
// ---------------------------------------------------------------------------

describe("SessionService", () => {
  it("creates a new session", () => {
    const result = service.createSession("Hello bot");

    expect(result.isNew).toBe(true);
    expect(result.session.title).toBe("Hello bot");
    expect(result.history).toHaveLength(1);
    expect(result.history[0]!.role).toBe("user");
    expect(result.history[0]!.content).toBe("Hello bot");
  });

  it("continues an existing session by id", () => {
    const first = service.createSession("First message");

    service.recordAssistantResult(first.session.id, {
      text: "Bot reply",
      toolCalls: []
    });

    const second = service.continueSession(first.session.id, "Second message");

    expect(second).toBeDefined();
    expect(second!.isNew).toBe(false);
    expect(second!.session.id).toBe(first.session.id);
    expect(second!.history).toHaveLength(3);
    expect(second!.history[0]!.content).toBe("First message");
    expect(second!.history[1]!.content).toBe("Bot reply");
    expect(second!.history[2]!.content).toBe("Second message");
  });

  it("returns undefined for unknown session id", () => {
    expect(service.continueSession("nonexistent", "Hi")).toBeUndefined();
  });

  it("resolves by key (IM scenario)", () => {
    const first = service.resolveByKey("thread:abc", "First");

    expect(first.isNew).toBe(true);

    service.recordAssistantResult(first.session.id, {
      text: "Reply",
      toolCalls: []
    });

    const second = service.resolveByKey("thread:abc", "Second");

    expect(second.isNew).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    expect(second.history).toHaveLength(3);
  });

  it("records assistant result with tool calls as structured content", () => {
    const { session } = service.createSession("Analyze issue");

    service.recordAssistantResult(session.id, {
      text: "Found the bug",
      toolCalls: [
        {
          toolName: "sentry_analyze_issue",
          toolCallId: "tc-1",
          args: { issueId: "123" },
          output: "NullPointerException at line 42",
          status: "success"
        }
      ]
    });

    const messages = messageRepo.findBySessionId(session.id);
    const assistantMsg = messages.find((m) => m.role === "assistant")!;
    const parsed = JSON.parse(assistantMsg.content);

    expect(parsed).toHaveLength(3);
    expect(parsed[0].type).toBe("tool_use");
    expect(parsed[0].toolName).toBe("sentry_analyze_issue");
    expect(parsed[1].type).toBe("tool_result");
    expect(parsed[1].output).toBe("NullPointerException at line 42");
    expect(parsed[2].type).toBe("text");
    expect(parsed[2].text).toBe("Found the bug");
  });

  it("strips tool markers from flattened history for agent", () => {
    const { session } = service.createSession("Analyze");

    service.recordAssistantResult(session.id, {
      text: "Done",
      toolCalls: [
        {
          toolName: "web_search",
          toolCallId: "tc-2",
          args: { query: "test" },
          output: "Search results here",
          status: "success"
        }
      ]
    });

    const continued = service.continueSession(session.id, "Follow up")!;
    const assistantHistory = continued.history.find((m) => m.role === "assistant")!;

    expect(assistantHistory.content).toBe("Done");
    expect(assistantHistory.content).not.toContain("[Called tool: web_search]");
    expect(assistantHistory.content).not.toContain("[Tool web_search success:");
  });

  it("records assistant message with token usage", () => {
    const { session } = service.createSession("Hi");
    const tokenUsage = JSON.stringify({ promptTokens: 10, completionTokens: 5 });

    const msg = service.recordAssistantResult(
      session.id,
      { text: "Response", toolCalls: [] },
      tokenUsage
    );

    expect(msg.tokenUsage).toBe(tokenUsage);
  });

  it("keeps different sessions isolated", () => {
    const a = service.createSession("Message A");
    const b = service.createSession("Message B");

    const a2 = service.continueSession(a.session.id, "Follow up A")!;
    const b2 = service.continueSession(b.session.id, "Follow up B")!;

    expect(a2.session.id).not.toBe(b2.session.id);
    expect(a2.history).toHaveLength(2);
    expect(b2.history).toHaveLength(2);
  });
});
