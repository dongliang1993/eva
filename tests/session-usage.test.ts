import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../apps/server/src/config.js";
import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { DrizzleSessionRepository } from "../apps/server/src/db/repositories/session-repository.js";
import { DrizzleMessageRepository } from "../apps/server/src/db/repositories/message-repository.js";
import { SessionService } from "../apps/server/src/services/session.js";
import { readSessionUsage } from "../apps/server/src/services/session-usage.js";
import { updateProvider } from "../apps/server/src/services/providers/provider-repository.js";
import { createUserUIMessage } from "../packages/shared/src/index.js";

let db: AppDatabase;

const runUsageA = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
const runUsageB = { inputTokens: 200, outputTokens: 75, totalTokens: 275 };

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
});

afterEach(() => {
  closeDb(db);
});

const config = loadConfig({ env: {}, cwd: "/tmp" });

describe("readSessionUsage", () => {
  it("累加三条 run 的用量,再算一条 running(无 usage)", () => {
    const sessionRepo = new DrizzleSessionRepository(db);
    sessionRepo.create({ id: "s-u" });

    // started_at 是秒粒度,手动指定逐渐递增的 ISO 时间保证 lastRun 顺序确定。
    const sqlite = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
    const insert = sqlite.prepare(
      `INSERT INTO runs (id, session_id, status, model, usage, started_at, ended_at)
       VALUES (?, ?, ?, 'openai:test', ?, ?, ?)`
    );
    const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
    insert.run("run-1", "s-u", "completed", JSON.stringify(runUsageA), iso(3000), iso(2000));
    insert.run("run-2", "s-u", "completed", JSON.stringify(runUsageB), iso(2000), iso(1000));
    insert.run("run-3", "s-u", "running", null, iso(1000), null);

    // 造一条消息让 contextTokens 非零。
    new DrizzleMessageRepository(db).create({
      sessionId: "s-u",
      message: createUserUIMessage(randomUUID(), "一条消息")
    });

    const sessionService = new SessionService(sessionRepo, new DrizzleMessageRepository(db));
    const result = readSessionUsage(db, config, sessionService, "s-u");

    expect(result.runCount).toBe(3);
    expect(result.totalUsage).toMatchObject({ inputTokens: 300, outputTokens: 125 });
    expect(result.lastRun?.id).toBe("run-3");
    expect(result.lastRun?.status).toBe("running");
    expect(result.contextTokens).toBeGreaterThan(0);
  });

  it("会话绑定了模型 → contextWindow 取该模型的窗口(不是全局设置)", () => {
    updateProvider(db, "openai", {
      enabled: true,
      apiKey: "k",
      baseURL: "https://db.example/v1",
      models: [
        { id: "m-big", name: "Big", capabilities: { contextWindow: 200_000 } }
      ],
      availableModels: []
    });

    const sessionRepo = new DrizzleSessionRepository(db);
    sessionRepo.create({ id: "s-bound" });
    // 一轮 run 跑完后 sessions.model 记着这轮选的模型。
    sessionRepo.updateModel("s-bound", "openai:m-big");

    const sessionService = new SessionService(sessionRepo, new DrizzleMessageRepository(db));
    const result = readSessionUsage(db, config, sessionService, "s-bound");

    expect(result.contextWindow).toBe(200_000);
  });

  it("会话还没绑定模型时 contextWindow 为 null(不抛)", () => {
    const sessionRepo = new DrizzleSessionRepository(db);
    sessionRepo.create({ id: "s-empty" });

    const sessionService = new SessionService(sessionRepo, new DrizzleMessageRepository(db));
    const result = readSessionUsage(db, config, sessionService, "s-empty");

    // 默认 seed providers 都 disabled → chat 槽位解析失败 → contextWindow null
    expect(result.contextWindow).toBeNull();
    expect(result.contextRatio).toBeNull();
    expect(result.runCount).toBe(0);
  });

  it("有消息时 contextTokens 随历史增长", () => {
    const sessionRepo = new DrizzleSessionRepository(db);
    sessionRepo.create({ id: "s-msg" });
    const messageRepo = new DrizzleMessageRepository(db);

    const first = messageRepo.create({
      sessionId: "s-msg",
      message: createUserUIMessage(randomUUID(), "这是一段很长的中文用户消息用于估算"),
      slotId: randomUUID(),
      depth: 0
    });
    sessionRepo.updateActiveLeaf("s-msg", first.id);

    const sessionService = new SessionService(sessionRepo, messageRepo);
    const before = readSessionUsage(db, config, sessionService, "s-msg").contextTokens;

    const second = messageRepo.create({
      sessionId: "s-msg",
      message: createUserUIMessage(randomUUID(), "又多了一条消息"),
      parentId: first.id,
      slotId: randomUUID(),
      depth: 1
    });
    sessionRepo.updateActiveLeaf("s-msg", second.id);
    const after = readSessionUsage(db, config, sessionService, "s-msg").contextTokens;

    expect(after).toBeGreaterThan(before);
  });
});