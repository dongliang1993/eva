import { randomUUID } from "node:crypto";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { runToolText } from "../../helpers/run-tool.js";

import { loadConfig } from "../../../apps/server/src/config.js";
import { closeDb, initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import {
  DrizzleMemoryRepository,
  recordMemoryRetrieval,
  retrieveMemoriesForRun,
  createMemoryTools,
  type IMemoryRepository
} from "../../../apps/server/src/modules/memory/index.js";
import { runMemoryRefs, runs, sessions } from "../../../apps/server/src/db/schema.js";
import { loadAppSettings } from "../../../apps/server/src/modules/settings/index.js";
import { estimateTokens } from "../../../apps/server/src/lib/token-estimator.js";

let db: AppDatabase;
let repo: IMemoryRepository;

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  repo = new DrizzleMemoryRepository(db);
});

afterEach(() => closeDb(db));

// ---------------------------------------------------------------------------
// Repository CRUD
// ---------------------------------------------------------------------------

describe("DrizzleMemoryRepository", () => {
  it("saves and retrieves a memory", () => {
    const memory = repo.save({
      id: randomUUID(),
      content: "User prefers TypeScript"
    });

    expect(memory.content).toBe("User prefers TypeScript");
    expect(memory.userId).toBe("default");

    const found = repo.findById(memory.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe("User prefers TypeScript");
  });

  it("lists all memories", () => {
    repo.save({ id: randomUUID(), content: "Fact A" });
    repo.save({ id: randomUUID(), content: "Fact B" });
    repo.save({ id: randomUUID(), content: "Fact C" });

    const all = repo.listAll();
    expect(all).toHaveLength(3);
  });

  it("searches by keyword", () => {
    repo.save({ id: randomUUID(), content: "User name is Liang" });
    repo.save({ id: randomUUID(), content: "Project uses React" });
    repo.save({ id: randomUUID(), content: "Prefers dark theme" });

    const results = repo.search("React");
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("React");
  });

  it("returns empty for no match", () => {
    repo.save({ id: randomUUID(), content: "User name is Liang" });

    const results = repo.search("Python");
    expect(results).toHaveLength(0);
  });

  it("updates a memory", () => {
    const memory = repo.save({
      id: randomUUID(),
      content: "Likes apples"
    });

    const updated = repo.update(memory.id, "Does NOT like apples");
    expect(updated).toBeDefined();
    expect(updated!.content).toBe("Does NOT like apples");

    const found = repo.findById(memory.id);
    expect(found!.content).toBe("Does NOT like apples");
  });

  it("deletes a memory", () => {
    const memory = repo.save({
      id: randomUUID(),
      content: "Temporary fact"
    });

    expect(repo.deleteById(memory.id)).toBe(true);
    expect(repo.findById(memory.id)).toBeUndefined();
  });

  it("returns false when deleting non-existent memory", () => {
    expect(repo.deleteById("nonexistent")).toBe(false);
  });

  it("saves with source session and message ids", () => {
    const memory = repo.save({
      id: randomUUID(),
      content: "Discussed architecture",
      sourceSessionId: "thread-1",
      sourceMessageId: "msg-1"
    });

    expect(memory.sourceSessionId).toBe("thread-1");
    expect(memory.sourceMessageId).toBe("msg-1");
  });

  it("retrieves global and current-workspace memories across source sessions", () => {
    repo.save({
      id: "global-memory",
      content: "The user prefers TypeScript architecture documents",
      sourceSessionId: "an-old-session"
    });
    repo.save({
      id: "current-workspace-memory",
      content: "The TypeScript server uses a single run loop",
      scopeKey: "workspace:workspace-a",
      sourceSessionId: "another-old-session"
    });
    repo.save({
      id: "other-workspace-memory",
      content: "The TypeScript server uses an unrelated convention",
      scopeKey: "workspace:workspace-b"
    });
    db.insert(sessions).values({ id: "current-session" }).run();
    db.insert(runs).values({ id: "current-run", sessionId: "current-session" }).run();

    const result = retrieveMemoriesForRun({
      memories: repo as DrizzleMemoryRepository,
      query: "Continue the TypeScript architecture work",
      workspaceId: "workspace-a",
      settings: loadAppSettings(db, loadConfig({ env: {}, cwd: "/tmp" })).memory
    });

    expect(result.memoryIds).toContain("global-memory");
    expect(result.memoryIds).toContain("current-workspace-memory");
    expect(result.memoryIds).not.toContain("other-workspace-memory");
    expect(result.section?.body).toContain("TypeScript");
    expect(db.select().from(runMemoryRefs).all()).toHaveLength(0);
    recordMemoryRetrieval(db, "current-run", result);
    expect(db.select().from(runMemoryRefs).all()).toHaveLength(2);
  });

  it("does not fall back to dumping memories for an empty FTS query", () => {
    repo.save({ id: "secret-memory", content: "A memory that must not be dumped" });
    expect(repo.search("a")).toEqual([]);
  });

  it("keeps accepted memory when its source session is deleted", () => {
    db.insert(sessions).values({ id: "source-session" }).run();
    const memory = repo.save({
      id: "durable-memory",
      content: "The user prefers concise replies",
      sourceSessionId: "source-session"
    });

    db.delete(sessions).run();

    expect(repo.findById(memory.id)?.sourceSessionId).toBe("source-session");
  });

  it("retrieves Chinese facts through the trigram index", () => {
    repo.save({ id: "chinese-memory", content: "用户正在重构服务端架构" });
    expect(repo.search("继续做服务端架构").map((memory) => memory.id))
      .toContain("chinese-memory");
  });

  it("supports two-character Chinese queries while respecting scopes and user identity", () => {
    repo.save({ id: "zh", content: "用户喜欢中文回答" });
    repo.save({ id: "other", content: "用户喜欢中文回答", userId: "another-user" });
    repo.save({ id: "elsewhere", content: "文档使用中文", scopeKey: "workspace:another" });
    expect(repo.searchRelevant("中文", ["global"]).map((memory) => memory.id)).toEqual(["zh"]);
    expect(repo.searchRelevant("%%", ["global"])).toEqual([]);
  });

  it("includes the heading and guidance in the retrieval token budget", () => {
    for (let i = 0; i < 5; i++) repo.save({ id: `fact-${i}`, content: "TypeScript " + "fact ".repeat(30) });
    const settings = loadAppSettings(db, loadConfig({ env: {}, cwd: "/tmp" })).memory;
    const result = retrieveMemoriesForRun({ memories: repo as DrizzleMemoryRepository,
      query: "TypeScript", settings: { ...settings, maxRetrieveTokens: 100 } });
    expect(result.section).toBeDefined();
    expect(estimateTokens(`## ${result.section!.heading}\n${result.section!.body}`)).toBeLessThanOrEqual(100);
    expect(result.tokenCount).toBeLessThanOrEqual(100);
  });

  it("tool-saved project facts carry workspace provenance and cannot update another workspace", async () => {
    const tools = createMemoryTools(db, loadConfig({ env: {}, cwd: "/tmp" }), {
      workspaceId: "current", sessionId: "session-a", runId: "run-a", userMessageId: "user-a"
    });
    const save = tools.find((tool) => tool.name === "save_memory")!;
    await runToolText(save, { content: "This project uses TypeScript", category: "project" }, { toolUseID: "save" });
    expect(repo.listAll()[0]).toMatchObject({ scopeKey: "workspace:current", sourceSessionId: "session-a",
      sourceRunId: "run-a", sourceMessageId: "user-a" });
    expect(repo.searchRelevant("TypeScript", ["global", "workspace:another"])).toEqual([]);
    repo.save({ id: "other-project", scopeKey: "workspace:another", content: "Original fact" });
    await runToolText(save, { updateId: "other-project", content: "Overwrite", category: "project" }, { toolUseID: "save" });
    expect(repo.findById("other-project")?.content).toBe("Original fact");
  });
});
