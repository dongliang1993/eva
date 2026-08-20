import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../apps/server/node_modules/fastify";

import { createUserUIMessage, uiMessageText } from "../packages/shared/src/index.js";
import { loadConfig } from "../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import { ApprovalRepository } from "../apps/server/src/db/repositories/approval-repository.js";
import { DrizzleMemoryRepository } from "../apps/server/src/db/repositories/memory-repository.js";
import { DrizzleMessageRepository } from "../apps/server/src/db/repositories/message-repository.js";
import { DrizzleSessionRepository } from "../apps/server/src/db/repositories/session-repository.js";
import { ApprovalGateway } from "../apps/server/src/services/approval-gateway.js";
import { SessionService } from "../apps/server/src/services/session.js";
import { registerHealthRoutes } from "../apps/server/src/routes/health.js";
import { registerMemoryRoutes } from "../apps/server/src/routes/memories.js";
import { registerModelRoutes } from "../apps/server/src/routes/models.js";
import { registerProviderRoutes } from "../apps/server/src/routes/providers.js";
import { registerSettingsRoutes } from "../apps/server/src/routes/settings.js";
import { registerThreadRoutes } from "../apps/server/src/routes/threads.js";

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
    skills: []
  });
  app.decorate("services", {
    approvals: new ApprovalGateway(new ApprovalRepository(db)),
    session: new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    ),
    agents: { invalidate() { /* no-op in this fixture */ } },
    workspaces: {} as never,
    runRegistry: {} as never,
    mcp: {} as never
  } as never);

  registerHealthRoutes(app);
  registerSettingsRoutes(app);
  registerProviderRoutes(app);
  registerModelRoutes(app);
  registerThreadRoutes(app);
  registerMemoryRoutes(app);

  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDb(db);
});

describe("Phase 1 API routes", () => {
  it("returns the new health shape", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/health"
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      status: string;
      timestamp: string;
    };

    expect(body.status).toBe("ok");
    expect(Number.isNaN(new Date(body.timestamp).getTime())).toBe(false);
  });

  it("returns and replaces full settings objects", async () => {
    const current = await app.inject({
      method: "GET",
      url: "/api/v1/settings"
    });

    expect(current.statusCode).toBe(200);

    const settings = current.json() as {
      models: Record<string, string>;
      security: { logLevel: string };
      providers?: unknown;
    };

    expect(settings.providers).toBeUndefined();
    // 主对话模型不是 settings 项 —— 它 per-run 由请求的 modelId 给。
    expect(settings.models.chat).toBeUndefined();

    const updated = {
      ...settings,
      models: {
        ...settings.models,
        tool: "openai:gpt-4o-mini"
      },
      security: {
        ...settings.security,
        logLevel: "debug"
      }
    };

    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: updated
    });

    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      models: { tool: "openai:gpt-4o-mini" },
      security: { logLevel: "debug" }
    });
    // chat 不该被 PUT 写进去(它不在契约里)。
    expect((put.json() as { models: Record<string, string> }).models.chat).toBeUndefined();
  });

  it("returns providers and aggregates enabled models", async () => {
    const providersResponse = await app.inject({
      method: "GET",
      url: "/api/v1/providers"
    });

    expect(providersResponse.statusCode).toBe(200);

    const providers = providersResponse.json() as Array<{
      id: string;
      hasApiKey: boolean;
      models: unknown[];
    }>;

    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    expect(typeof providers[0]!.hasApiKey).toBe("boolean");

    const enableProvider = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai",
      payload: {
        enabled: true
      }
    });

    expect(enableProvider.statusCode).toBe(200);

    const modelsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/models"
    });

    expect(modelsResponse.statusCode).toBe(200);

    const models = modelsResponse.json() as Array<{ id: string; providerId: string }>;

    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!.providerId).toBe("openai");
    expect(models[0]!.id.startsWith("openai:")).toBe(true);
  });

  it("returns thread lists and direct message arrays", async () => {
    const sessionRepo = new DrizzleSessionRepository(db);
    const messageRepo = new DrizzleMessageRepository(db);
    const session = sessionRepo.create({
      id: randomUUID(),
      title: "Debug thread"
    });

    messageRepo.create({
      sessionId: session.id,
      message: createUserUIMessage(randomUUID(), "hello")
    });

    const threadsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/threads"
    });

    expect(threadsResponse.statusCode).toBe(200);

    const threads = threadsResponse.json() as Array<{
      id: string;
      title: string;
      messageCount: number;
    }>;

    expect(Array.isArray(threads)).toBe(true);
    expect(threads[0]).toMatchObject({
      id: session.id,
      title: "Debug thread",
      messageCount: 1
    });

    const messagesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${session.id}/messages`
    });

    expect(messagesResponse.statusCode).toBe(200);

    const messages = messagesResponse.json() as Array<{ message: { parts: Array<{ type: string; text?: string }> } }>;

    expect(Array.isArray(messages)).toBe(true);
    expect(uiMessageText(messages[0]!.message)).toBe("hello");
  });

  it("returns direct memory arrays with thread-oriented fields", async () => {
    const memoryRepo = new DrizzleMemoryRepository(db);
    memoryRepo.save({
      id: randomUUID(),
      content: "User prefers concise answers",
      sourceSessionId: "thread-1",
      sourceMessageId: "msg-1"
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memories"
    });

    expect(listResponse.statusCode).toBe(200);

    const memories = listResponse.json() as Array<{
      content: string;
      sourceThreadId: string | null;
    }>;

    expect(Array.isArray(memories)).toBe(true);
    expect(memories[0]).toMatchObject({
      content: "User prefers concise answers",
      sourceThreadId: "thread-1"
    });

    const searchResponse = await app.inject({
      method: "POST",
      url: "/api/v1/memories/search",
      payload: { query: "concise" }
    });

    expect(searchResponse.statusCode).toBe(200);
    expect(Array.isArray(searchResponse.json())).toBe(true);
  });
});
