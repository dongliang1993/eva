import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";

import { createUserUIMessage, uiMessageText } from "../../../packages/shared/src/index.js";
import type { EvaUIMessage } from "../../../packages/shared/src/index.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { DrizzleMemoryRepository, MemoryExtractionRepository } from "../../../apps/server/src/modules/memory/index.js";
import { runs } from "../../../apps/server/src/db/schema.js";
import { DrizzleMessageRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { ApprovalRepository } from "../../../apps/server/src/modules/approvals/index.js";
import { SessionService } from "../../../apps/server/src/modules/sessions/index.js";
import { ApprovalGateway } from "../../../apps/server/src/modules/approvals/index.js";
import { registerMemoryRoutes } from "../../../apps/server/src/modules/memory/index.js";
import { registerSearchRoutes } from "../../../apps/server/src/modules/search/index.js";
import { registerSkillRoutes } from "../../../apps/server/src/modules/skills/index.js";
import { registerThreadRoutes } from "../../../apps/server/src/modules/sessions/index.js";
import { decorateAppApi } from "../../helpers/app-api.js";

const textMessage = (role: "user" | "assistant", text: string): EvaUIMessage =>
  role === "user"
    ? createUserUIMessage(randomUUID(), text)
    : { id: randomUUID(), role: "assistant", parts: [{ type: "text", text, state: "done" }] };

let app: FastifyInstance;
let db: AppDatabase;

beforeEach(async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);

  app = Fastify();
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    db,
    logger: {} as never,
    skills: [
      {
        name: "memory-management",
        description: "Use the alma CLI to manage long-term memory.",
        content: "# Memory Management",
        filePath: "/tmp/skills/memory-management/SKILL.md",
        source: "project"
      }
    ]
  });
  const approvals = new ApprovalGateway(new ApprovalRepository(db));
  app.decorate("services", {
    approvals,
    session: new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    ),
    agents: {
      invalidate() {},
      resolveModels() {
        throw new Error("chat 模型未配置");
      }
    } as never,
    workspaces: {} as never,
    runRegistry: {} as never,
    mcp: {
      describe() {
        return [];
      }
    } as never
  } as never);
  decorateAppApi(app);

  registerSearchRoutes(app);
  registerMemoryRoutes(app);
  registerSkillRoutes(app);
  registerThreadRoutes(app);

  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDb(db);
});

describe("Phase 4 API routes", () => {
  it("reviews memory candidates and rejects stale updates with HTTP 409", async () => {
    const session = new DrizzleSessionRepository(db).create({ id: randomUUID(), title: "Memory" });
    const runId = randomUUID();
    db.insert(runs).values({ id: runId, sessionId: session.id, status: "completed" }).run();
    const repo = new DrizzleMemoryRepository(db);
    const original = repo.save({ id: "fact", content: "Old preference", memoryKey: "preference.language" });
    const jobs = new MemoryExtractionRepository(db);
    jobs.enqueue({ id: "job", sourceRunId: runId, sessionId: session.id,
      sourceUserMessageId: "user", sourceAssistantMessageId: "assistant", modelId: "provider:model", mode: "review" });
    jobs.complete(jobs.claimNext()!, [{ action: "update", targetMemoryId: original.id,
      targetRevision: original.revision, category: "preference", scopeKey: "global",
      memoryKey: "preference.language", content: "Extracted preference", confidence: 95, evidenceMessageIds: ["user"] },
    { action: "create", category: "knowledge", scopeKey: "global", memoryKey: "known.fact",
      content: "Useful fact", confidence: 90, evidenceMessageIds: ["user"] }], repo);
    const list = await app.inject({ method: "GET", url: "/api/v1/memories/candidates" });
    expect(list.statusCode).toBe(200);
    const [stale, fresh] = list.json();
    repo.update("fact", "Manual correction");
    const conflict = await app.inject({ method: "POST", url: `/api/v1/memories/candidates/${stale.id}/accept` });
    expect(conflict.statusCode).toBe(409);
    expect(repo.findById("fact")?.content).toBe("Manual correction");
    expect((await app.inject({ method: "POST", url: `/api/v1/memories/candidates/${stale.id}/reject` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/v1/memories/candidates/${fresh.id}/accept` })).statusCode).toBe(200);
    expect(repo.findByKey("global", "known.fact")?.content).toBe("Useful fact");
    expect(jobs.listCandidates()).toEqual([]);
  });

  it("searches threads across titles and indexed message text without duplicates", async () => {
    const sessionRepo = new DrizzleSessionRepository(db);
    const messageRepo = new DrizzleMessageRepository(db);
    const thread = sessionRepo.create({
      id: randomUUID(),
      title: "React debugging"
    });

    messageRepo.create({
      sessionId: thread.id,
      message: textMessage("user", "React component crash")
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search/threads?q=React"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: thread.id,
        title: "React debugging",
        messageCount: 1,
        snippet: "React component crash"
      })
    ]);
  });

  it("returns memory stats in the Alma-aligned shape", async () => {
    const memoryRepo = new DrizzleMemoryRepository(db);
    memoryRepo.save({
      id: randomUUID(),
      content: "User prefers concise answers",
      category: "user"
    });
    memoryRepo.save({
      id: randomUUID(),
      content: "Project uses Drizzle ORM",
      category: "project"
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/memories/stats"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      count: 2,
      manualAdded: 2,
      autoGenerated: 0,
      byCategory: {
        user: 1,
        preference: 0,
        project: 1,
        decision: 0,
        knowledge: 0
      }
    });
  });

  it("returns loaded skills as read-only summaries", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/skills"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: "memory-management",
        name: "memory-management",
        description: "Use the alma CLI to manage long-term memory.",
        source: "project",
        enabled: true
      }
    ]);
  });

  it("compacts older thread messages into a persisted summary", async () => {
    const sessionRepo = new DrizzleSessionRepository(db);
    const messageRepo = new DrizzleMessageRepository(db);
    const thread = sessionRepo.create({
      id: randomUUID(),
      title: "Long conversation"
    });

    const contents: ReadonlyArray<["user" | "assistant", string]> = [
      ["user", "First user request"],
      ["assistant", "First assistant reply"],
      ["user", "Second user request"],
      ["assistant", "Second assistant reply"],
      ["user", "Third user request"],
      ["assistant", "Third assistant reply"],
      ["user", "Fourth user request"],
      ["assistant", "Fourth assistant reply"],
      ["user", "Fifth user request"],
      ["assistant", "Fifth assistant reply"],
      ["user", "Sixth user request"],
      ["assistant", "Sixth assistant reply"]
    ];

    let parentId: string | undefined;
    let depth = 0;

    for (const [role, content] of contents) {
      // 线性对话:每条消息一个新 slot(位置),parent 指向上一条。
      const stored = messageRepo.create({
        sessionId: thread.id,
        message: textMessage(role, content),
        ...(parentId !== undefined ? { parentId } : {}),
        slotId: randomUUID(),
        depth
      });
      parentId = stored.id;
      depth += 1;
    }

    // T12 起会话有 active_leaf 指针;GET messages 只返回激活链。
    sessionRepo.updateActiveLeaf(thread.id, parentId!);

    const compactResponse = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${thread.id}/compact`
    });

    expect(compactResponse.statusCode).toBe(200);
    expect(compactResponse.json()).toMatchObject({
      success: true,
      compacted: true,
      trigger: "manual",
      coveredMessageCount: 4,
      preservedTailMessageCount: 8,
      estimatedTokensBefore: expect.any(Number),
      estimatedTokensAfter: expect.any(Number),
      compactionId: expect.any(String),
      thread: {
        id: thread.id,
        messageCount: 12
      }
    });

    const messagesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${thread.id}/messages`
    });

    expect(messagesResponse.statusCode).toBe(200);

    const compactedMessages = messagesResponse.json() as Array<{
      role: string;
      message: EvaUIMessage;
    }>;

    expect(compactedMessages).toHaveLength(12);
    expect(compactedMessages.map((message) => uiMessageText(message.message))).toEqual([
      "First user request",
      "First assistant reply",
      "Second user request",
      "Second assistant reply",
      "Third user request",
      "Third assistant reply",
      "Fourth user request",
      "Fourth assistant reply",
      "Fifth user request",
      "Fifth assistant reply",
      "Sixth user request",
      "Sixth assistant reply"
    ]);

    const sessionService = new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    );
    const modelHistory = sessionService.buildModelHistory(db, thread.id);

    expect(modelHistory.summary).toContain("Conversation summary");
    expect(modelHistory.summary).toContain("First user request");
    expect(modelHistory.messages.map((m) => uiMessageText(m))).toEqual([
      "Third user request",
      "Third assistant reply",
      "Fourth user request",
      "Fourth assistant reply",
      "Fifth user request",
      "Fifth assistant reply",
      "Sixth user request",
      "Sixth assistant reply"
    ]);
  });

  it("returns a no-op compact result for short threads", async () => {
    const sessionRepo = new DrizzleSessionRepository(db);
    const messageRepo = new DrizzleMessageRepository(db);
    const thread = sessionRepo.create({
      id: randomUUID(),
      title: "Short conversation"
    });

    let parentId: string | undefined;
    for (const [depth, content] of ["One", "Two", "Three"].entries()) {
      const stored = messageRepo.create({
        sessionId: thread.id, depth,
        ...(parentId ? { parentId } : {}),
        message: textMessage(content === "Two" ? "assistant" : "user", content)
      });
      parentId = stored.id;
      sessionRepo.updateActiveLeaf(thread.id, stored.id);
    }

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${thread.id}/compact`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      compacted: false,
      trigger: "manual",
      coveredMessageCount: 0,
      preservedTailMessageCount: 3,
      estimatedTokensBefore: expect.any(Number),
      estimatedTokensAfter: expect.any(Number),
      thread: {
        id: thread.id,
        messageCount: 3
      }
    });
  });
});
