import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "../../../apps/server/node_modules/drizzle-orm/index.js";

import { createUserUIMessage } from "../../../packages/shared/src/index.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import { closeDb, initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import {
  memories,
  memoryCandidates,
  memoryExtractionJobs,
  runs,
  sessions
} from "../../../apps/server/src/db/schema.js";
import { usageRecords } from "../../../apps/server/src/db/schema.js";
import { IdentityEncryptor } from "../../../apps/server/src/infrastructure/crypto/encryptor.js";
import {
  DrizzleMemoryRepository,
  MemoryAutomationService,
  MemoryExtractionRepository
} from "../../../apps/server/src/modules/memory/index.js";
import { DrizzleMessageRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { loadAppSettings, replaceAppSettings } from "../../../apps/server/src/modules/settings/index.js";
import { createSettingsApi } from "../../../apps/server/src/modules/settings/index.js";
import type { ExtractMemories } from "../../../apps/server/src/modules/memory/index.js";

let db: AppDatabase;

const logger = { warn: () => {} };
const config = loadConfig({ env: {}, cwd: "/tmp" });
const services: MemoryAutomationService[] = [];

const serviceWith = (extract: ExtractMemories) => {
  const service = new MemoryAutomationService({ db, config, encryptor: new IdentityEncryptor(), logger, extract });
  services.push(service);
  return service;
};

const enqueueRun = (service: MemoryAutomationService, id: string, mode: "review" | "automatic" = "review") => {
  const { userId, assistantId } = seedRun(id);
  return service.enqueue({ sourceRunId: id, sessionId: `session-${id}`, sourceUserMessageId: userId,
    sourceAssistantMessageId: assistantId, modelId: "provider:tool-model", mode });
};

const preference = {
  action: "create" as const, category: "preference" as const, scope: "global" as const,
  memoryKey: "preference.response.style", content: "The user prefers concise replies.", confidence: 96
};

const seedRun = (id: string): { userId: string; assistantId: string } => {
  const sessionId = `session-${id}`;
  const userId = `user-${id}`;
  const assistantId = `assistant-${id}`;
  db.insert(sessions).values({ id: sessionId }).run();
  db.insert(runs).values({ id, sessionId, status: "completed" }).run();
  const messages = new DrizzleMessageRepository(db);
  messages.create({ sessionId, runId: id, message: createUserUIMessage(userId, "I prefer concise Chinese replies") });
  messages.create({
    sessionId,
    runId: id,
    message: { id: assistantId, role: "assistant", parts: [{ type: "text", text: "Understood.", state: "done" }] }
  });
  return { userId, assistantId };
};

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  const settings = loadAppSettings(db, config);
  replaceAppSettings(db, config, { ...settings, memory: { ...settings.memory,
    autoSummarize: true, autoSummarizeMode: "automatic" } });
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.useRealTimers();
  closeDb(db);
});

describe("memory extraction jobs", () => {
  it("persists review candidates and saves them only after acceptance", async () => {
    const { userId, assistantId } = seedRun("run-review");
    const service = new MemoryAutomationService({
      db,
      config: loadConfig({ env: {}, cwd: "/tmp" }),
      encryptor: new IdentityEncryptor(),
      logger,
      extract: async () => ({
        candidates: [{
          action: "create",
          category: "preference",
          scope: "global",
          memoryKey: "preference.response.style",
          content: "The user prefers concise Chinese replies.",
          confidence: 96
        }]
      })
    });
    expect(service.enqueue({
      sourceRunId: "run-review",
      sessionId: "session-run-review",
      sourceUserMessageId: userId,
      sourceAssistantMessageId: assistantId,
      modelId: "provider:tool-model",
      mode: "review"
    })).toBe(true);

    service.start();
    await service.whenIdle();
    await service.close();

    expect(db.select().from(memories).all()).toHaveLength(0);
    const candidate = db.select().from(memoryCandidates).get()!;
    expect(candidate.status).toBe("pending");
    const extraction = new MemoryExtractionRepository(db);
    expect(extraction.acceptCandidate(candidate.id, new DrizzleMemoryRepository(db))?.status).toBe("accepted");
    expect(db.select().from(memories).get()).toMatchObject({
      origin: "auto_extracted",
      scopeKey: "global",
      memoryKey: "preference.response.style",
      sourceSessionId: "session-run-review"
    });
  });

  it("auto-saves only high-confidence candidates and keeps provenance", async () => {
    const { userId, assistantId } = seedRun("run-auto");
    const service = new MemoryAutomationService({
      db,
      config: loadConfig({ env: {}, cwd: "/tmp" }),
      encryptor: new IdentityEncryptor(),
      logger,
      extract: async () => ({
        candidates: [
          {
            action: "create",
            category: "project",
            scope: "workspace",
            memoryKey: "project.language",
            content: "This project uses TypeScript.",
            confidence: 90
          },
          {
            action: "create",
            category: "knowledge",
            scope: "global",
            memoryKey: "uncertain.fact",
            content: "An uncertain fact.",
            confidence: 60
          }
        ]
      })
    });
    service.enqueue({
      sourceRunId: "run-auto",
      sessionId: "session-run-auto",
      workspaceId: "workspace-a",
      sourceUserMessageId: userId,
      sourceAssistantMessageId: assistantId,
      modelId: "provider:tool-model",
      mode: "automatic"
    });

    service.start();
    await service.whenIdle();
    await service.close();

    expect(db.select().from(memories).all()).toEqual([
      expect.objectContaining({
        scopeKey: "workspace:workspace-a",
        sourceRunId: "run-auto",
        confidence: 90
      })
    ]);
    expect(db.select().from(memoryCandidates).all().map((row) => row.status).sort())
      .toEqual(["auto_saved", "pending"]);
    expect(db.select().from(memoryExtractionJobs).get()).toMatchObject({
      status: "completed",
      attempts: 1
    });
  });

  it("requeues a job left running by a crashed process", () => {
    const { userId, assistantId } = seedRun("run-recover");
    const jobs = new MemoryExtractionRepository(db);
    jobs.enqueue({
      id: "job-recover",
      sourceRunId: "run-recover",
      sessionId: "session-run-recover",
      sourceUserMessageId: userId,
      sourceAssistantMessageId: assistantId,
      modelId: "provider:tool-model",
      mode: "review"
    });
    expect(jobs.claimNext()?.status).toBe("running");
    expect(jobs.recoverInterrupted()).toBe(1);
    expect(db.select().from(memoryExtractionJobs).get()?.status).toBe("pending");
  });

  it("shutdown aborts the active call and preserves the queue without starting more calls", async () => {
    const extract = vi.fn<ExtractMemories>(({ abortSignal }) => new Promise((_, reject) => {
      abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const service = serviceWith(extract);
    enqueueRun(service, "shutdown-one");
    enqueueRun(service, "shutdown-two");
    service.start();
    await Promise.resolve();
    expect(extract).toHaveBeenCalledTimes(1);
    await service.close();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(db.select().from(memoryExtractionJobs).all().map((job) => [job.status, job.attempts]))
      .toEqual([["pending", 0], ["pending", 0]]);

    const restarted = serviceWith(async () => ({ candidates: [] }));
    restarted.start();
    await restarted.whenIdle();
    expect(db.select().from(memoryExtractionJobs).all().every((job) => job.status === "completed")).toBe(true);
  });

  it("settings disable aborts active extraction and cancels queued work", async () => {
    const extract = vi.fn<ExtractMemories>(({ abortSignal }) => new Promise((_, reject) => {
      abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const service = serviceWith(extract);
    enqueueRun(service, "disable-one");
    enqueueRun(service, "disable-two");
    service.start();
    await Promise.resolve();
    const settings = loadAppSettings(db, config);
    createSettingsApi({ db, config, agents: { invalidate() {} }, memoryAutomation: service }).replace({
      ...settings, memory: { ...settings.memory, enabled: false }
    });
    await service.whenIdle();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(db.select().from(memoryExtractionJobs).all().every((job) => job.status === "canceled")).toBe(true);
    expect(db.select().from(memories).all()).toEqual([]);
  });

  it("retries with backoff and stops after three failures", async () => {
    vi.useFakeTimers();
    const extract = vi.fn<ExtractMemories>(async () => { throw new Error("unavailable"); });
    const service = serviceWith(extract);
    enqueueRun(service, "retry");
    service.start();
    await service.whenIdle();
    expect(extract).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(extract).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(extract).toHaveBeenCalledTimes(3);
    expect(db.select().from(memoryExtractionJobs).get()).toMatchObject({ status: "failed", attempts: 3 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it("marks an interrupted third attempt terminal instead of stranding it pending", () => {
    const service = serviceWith(async () => ({ candidates: [] }));
    enqueueRun(service, "third");
    db.update(memoryExtractionJobs).set({ status: "running", attempts: 3 }).run();
    new MemoryExtractionRepository(db).recoverInterrupted();
    expect(db.select().from(memoryExtractionJobs).get()?.status).toBe("failed");
  });

  it.each(["edit", "delete"])("does not overwrite a manual %s made while extraction was pending", async (action) => {
    const repo = new DrizzleMemoryRepository(db);
    repo.save({ id: "old", content: "Original preference", memoryKey: preference.memoryKey });
    const service = serviceWith(async () => {
      if (action === "edit") repo.update("old", "User's newer preference");
      else repo.deleteById("old");
      return { candidates: [{ ...preference, action: "update", targetMemoryId: "old" }] };
    });
    enqueueRun(service, `conflict-${action}`, "automatic");
    service.start();
    await service.whenIdle();
    const candidate = db.select().from(memoryCandidates).get()!;
    expect(candidate.status).toBe("pending");
    expect(() => new MemoryExtractionRepository(db).acceptCandidate(candidate.id, repo)).toThrow("记忆已被修改");
    expect(repo.findById("old")?.content).toBe(action === "edit" ? "User's newer preference" : undefined);
  });

  it("cannot recreate a memory after its source session and job were deleted mid-call", async () => {
    const service = serviceWith(async ({ job }) => {
      db.delete(sessions).where(eq(sessions.id, job.sessionId)).run();
      return { candidates: [preference] };
    });
    enqueueRun(service, "deleted-source", "automatic");
    service.start();
    await service.whenIdle();
    expect(db.select().from(memories).all()).toEqual([]);
    expect(db.select().from(memoryCandidates).all()).toEqual([]);
  });

  it("does not promote a workspace fact to global when no workspace is bound", async () => {
    const service = serviceWith(async () => ({ candidates: [{ ...preference, scope: "workspace" }] }));
    enqueueRun(service, "missing-workspace", "automatic");
    service.start();
    await service.whenIdle();
    expect(db.select().from(memories).all()).toEqual([]);
  });

  it("records auxiliary usage even when candidate validation fails", async () => {
    const service = serviceWith(async () => ({
      candidates: [{ ...preference, confidence: 150 }],
      usage: {
        inputTokens: 20, outputTokens: 10, totalTokens: 30,
        inputTokenDetails: { noCacheTokens: 15, cacheReadTokens: 5, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 8, reasoningTokens: 2 }
      }
    }));
    enqueueRun(service, "usage");
    service.start();
    await service.whenIdle();
    expect(db.select().from(usageRecords).all()).toEqual([expect.objectContaining({
      model: "provider:tool-model", totalTokens: 30, cachedInputTokens: 5, reasoningTokens: 2
    })]);
    expect(db.select().from(memoryExtractionJobs).get()?.status).toBe("pending");
  });

  it("settles a claim once and prevents a repeated result from writing twice", () => {
    const service = serviceWith(async () => ({ candidates: [] }));
    enqueueRun(service, "settle");
    const jobs = new MemoryExtractionRepository(db);
    const job = jobs.claimNext()!;
    const candidate = { ...preference, scopeKey: "global", evidenceMessageIds: ["user-settle"] };
    const repo = new DrizzleMemoryRepository(db);
    expect(jobs.complete(job, [candidate], repo)).toBe(true);
    expect(jobs.complete(job, [candidate], repo)).toBe(false);
    expect(db.select().from(memoryCandidates).all()).toHaveLength(1);
  });
});
