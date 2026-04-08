import { randomUUID } from "node:crypto";

import { describe, expect, it, beforeEach } from "vitest";

import { loadConfig } from "../apps/server/src/config.js";
import { initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import {
  DrizzleMemoryRepository,
  type IMemoryRepository
} from "../apps/server/src/db/repositories/memory-repository.js";
import {
  buildMemoryRuntimeSupport,
} from "../apps/server/src/services/memory-runtime.js";
import {
  calculateMemoryContextTokenBudget,
  renderRecallPromptContext,
  type RecalledHistoryHit,
  type RecalledMemoryEntry
} from "../apps/server/src/services/memory-recall.js";

let db: AppDatabase;
let repo: IMemoryRepository;

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  repo = new DrizzleMemoryRepository(db);
});

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

  it("renders recalled memory context within the available token budget", () => {
    const memoryEntries: readonly RecalledMemoryEntry[] = [
      {
        id: "m1",
        category: "user",
        origin: "manual",
        content: "User prefers concise answers.",
        sourceSessionId: null,
        sourceMessageId: null,
        createdAt: "2026-04-05T00:00:00.000Z",
        updatedAt: "2026-04-05T00:00:00.000Z",
        estimatedTokens: 8
      },
      {
        id: "m2",
        category: "project",
        origin: "manual",
        content: "Project uses Drizzle ORM with SQLite and semantic memory recall. ".repeat(20).trim(),
        sourceSessionId: null,
        sourceMessageId: null,
        createdAt: "2026-04-05T00:00:00.000Z",
        updatedAt: "2026-04-05T00:00:00.000Z",
        estimatedTokens: 300
      }
    ];
    const historyHits: readonly RecalledHistoryHit[] = [
      {
        messageId: "msg-1",
        sessionId: "thread-1",
        content: "We previously discussed Drizzle migration pitfalls and memory compaction.",
        snippet: "We previously discussed Drizzle migration pitfalls and memory compaction.",
        rank: -1,
        estimatedTokens: 18
      }
    ];

    const rendered = renderRecallPromptContext(
      { memoryEntries, historyHits },
      { tokenBudget: 120 }
    );

    expect(rendered.usedMemoryIds).toContain("m1");
    expect(rendered.usedMemoryIds).not.toContain("m2");
    expect(rendered.promptContext).toContain("User prefers concise answers.");
    expect(rendered.promptContext).not.toContain("semantic memory recall.");
  });

  it("computes memory budget from remaining context headroom", () => {
    const budget = calculateMemoryContextTokenBudget({
      modelHistory: [
        { content: "A short chat history entry." }
      ],
      existingContext: {
        incident: "Sentry issue RCA"
      },
      contextWindow: 20_000,
      reservedOutputTokens: 4_000
    });

    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(8_000);
  });

  it("builds budget-aware memory runtime context for recalled memories", async () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });
    const shortMemory = repo.save({
      id: randomUUID(),
      category: "project",
      content: "Project guidance: keep RCA answers concise and action-oriented."
    });
    const longMemory = repo.save({
      id: randomUUID(),
      category: "project",
      content: "Project guidance: "
        + "capture every implementation detail about Drizzle, SQLite, embeddings, "
        + "retrieval, migration history, API compatibility, and rollout notes. ".repeat(20).trim()
    });

    const runtime = await buildMemoryRuntimeSupport({
      db,
      config,
      userMessage: "Need project guidance for the next RCA reply",
      modelHistory: [
        { role: "user", content: "Summarize the latest issue." }
      ],
      modelLimits: {
        contextWindow: 1_000,
        maxOutputTokens: 500
      }
    });

    expect(runtime.additionalTools).toHaveLength(2);
    expect(runtime.memoryBudgetTokens).toBeGreaterThan(0);
    expect(runtime.memoryContext).toContain(shortMemory.content);
    expect(runtime.usedMemoryIds).toContain(shortMemory.id);
    expect(runtime.usedMemoryIds).not.toContain(longMemory.id);
    expect(runtime.memoryContext).not.toContain("retrieval, migration history");
  });
});
