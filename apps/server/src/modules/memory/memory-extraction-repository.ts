import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import type { MemoryCandidateRecord } from "@eva/shared";
import type { LanguageModelUsage } from "ai";
import type { AppDatabase } from "../../db/index.js";
import {
  memoryCandidates,
  memoryExtractionJobs,
  sessions,
  usageRecords,
  type MemoryCategory
} from "../../db/schema.js";
import { MemoryConflictError, type DrizzleMemoryRepository } from "./memory-repository.js";

export interface MemoryExtractionJob {
  readonly id: string;
  readonly sourceRunId: string;
  readonly sessionId: string;
  readonly workspaceId: string | null;
  readonly sourceUserMessageId: string;
  readonly sourceAssistantMessageId: string;
  readonly modelId: string;
  readonly mode: "review" | "automatic";
  readonly status: "pending" | "running" | "completed" | "failed" | "canceled";
  readonly attempts: number;
  readonly retryAt: number;
  readonly error: string | null;
  readonly usage: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface ExtractedMemoryCandidate {
  readonly action: "create" | "update";
  readonly targetMemoryId?: string | undefined;
  readonly targetRevision?: number | undefined;
  readonly category: MemoryCategory;
  readonly scopeKey: string;
  readonly memoryKey: string;
  readonly content: string;
  readonly confidence: number;
  readonly evidenceMessageIds: readonly string[];
}

const parseStringArray = (value: string): readonly string[] => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
};

const toCandidateRecord = (row: typeof memoryCandidates.$inferSelect): MemoryCandidateRecord => ({
  id: row.id,
  jobId: row.jobId,
  action: row.action,
  targetMemoryId: row.targetMemoryId,
  category: row.category,
  scopeKey: row.scopeKey as MemoryCandidateRecord["scopeKey"],
  memoryKey: row.memoryKey,
  content: row.content,
  confidence: row.confidence,
  evidenceMessageIds: parseStringArray(row.evidenceMessageIds),
  status: row.status,
  createdAt: row.createdAt,
  decidedAt: row.decidedAt
});

export class MemoryExtractionRepository {
  constructor(private readonly db: AppDatabase) { }

  enqueue(input: {
    readonly id: string;
    readonly sourceRunId: string;
    readonly sessionId: string;
    readonly workspaceId?: string | undefined;
    readonly sourceUserMessageId: string;
    readonly sourceAssistantMessageId: string;
    readonly modelId: string;
    readonly mode: "review" | "automatic";
  }): boolean {
    return this.db.insert(memoryExtractionJobs).values(input).onConflictDoNothing().run().changes > 0;
  }

  /** A process crash cannot leave a job permanently claimed. */
  recoverInterrupted(): number {
    return this.db.transaction(() => {
      this.db.update(memoryExtractionJobs).set({
        status: "failed", endedAt: new Date().toISOString(), error: "retry limit reached after interruption"
      }).where(and(inArray(memoryExtractionJobs.status, ["running", "pending"]),
        gte(memoryExtractionJobs.attempts, 3))).run();
      return this.db.update(memoryExtractionJobs).set({
        status: "pending", startedAt: null, retryAt: 0,
        error: "worker interrupted by process restart"
      }).where(eq(memoryExtractionJobs.status, "running")).run().changes;
    });
  }

  claimNext(now = Date.now()): MemoryExtractionJob | undefined {
    return this.db.transaction(() => {
      const next = this.db.select().from(memoryExtractionJobs).where(and(
        eq(memoryExtractionJobs.status, "pending"),
        lt(memoryExtractionJobs.attempts, 3),
        lte(memoryExtractionJobs.retryAt, now)
      )).orderBy(asc(memoryExtractionJobs.createdAt)).limit(1).get();
      if (!next) return undefined;

      const claimed = this.db.update(memoryExtractionJobs).set({
        status: "running",
        attempts: sql`${memoryExtractionJobs.attempts} + 1`,
        startedAt: new Date().toISOString(),
        error: null
      }).where(and(
        eq(memoryExtractionJobs.id, next.id),
        eq(memoryExtractionJobs.status, "pending")
      )).returning().get();
      return claimed;
    });
  }

  /** Count auxiliary calls separately, including responses rejected by the schema. */
  recordUsage(job: MemoryExtractionJob, usage: LanguageModelUsage): void {
    this.db.transaction(() => {
      if (!this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, job.sessionId)).get()) return;
      this.db.insert(usageRecords).values({
        id: `memory-extraction:${job.id}:${job.attempts}:${job.startedAt}`,
        runId: job.sourceRunId, sessionId: job.sessionId, model: job.modelId,
        date: new Date().toISOString().slice(0, 10),
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
        cachedInputTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
        reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? 0
      }).onConflictDoNothing().run();
      this.db.update(memoryExtractionJobs).set({ usage: JSON.stringify(usage) })
        .where(eq(memoryExtractionJobs.id, job.id)).run();
    });
  }

  complete(
    job: MemoryExtractionJob,
    candidates: readonly ExtractedMemoryCandidate[],
    memories: DrizzleMemoryRepository,
    usage?: unknown
  ): boolean {
    return this.db.transaction(() => {
      // Settlement belongs to the current claim. A deleted/canceled/already
      // completed job must not create memories or duplicate review candidates.
      const changed = this.db.update(memoryExtractionJobs).set({
        status: "completed", endedAt: new Date().toISOString(), error: null,
        ...(usage !== undefined ? { usage: JSON.stringify(usage) } : {})
      }).where(this.claimPredicate(job)).run().changes;
      if (!changed) return false;
      for (const candidate of candidates) {
        const id = crypto.randomUUID();
        let autoSave = job.mode === "automatic" && candidate.confidence >= 85;
        if (autoSave) {
          try { this.persistCandidate(candidate, job, memories); }
          catch (error) {
            if (!(error instanceof MemoryConflictError)) throw error;
            autoSave = false;
          }
        }
        this.db.insert(memoryCandidates).values({
          id,
          jobId: job.id,
          action: candidate.action,
          ...(candidate.targetMemoryId ? { targetMemoryId: candidate.targetMemoryId } : {}),
          ...(candidate.targetRevision !== undefined ? { targetRevision: candidate.targetRevision } : {}),
          category: candidate.category,
          scopeKey: candidate.scopeKey,
          memoryKey: candidate.memoryKey,
          content: candidate.content,
          confidence: candidate.confidence,
          evidenceMessageIds: JSON.stringify(candidate.evidenceMessageIds),
          status: autoSave ? "auto_saved" : "pending",
          ...(autoSave ? { decidedAt: new Date().toISOString() } : {})
        }).run();

      }
      return true;
    });
  }

  fail(job: MemoryExtractionJob, error: string, now = Date.now()): void {
    const terminal = job.attempts >= 3;
    this.db.update(memoryExtractionJobs).set({
      status: terminal ? "failed" : "pending",
      error: error.slice(0, 1000),
      retryAt: terminal ? 0 : now + 1000 * 2 ** (job.attempts - 1),
      ...(terminal ? { endedAt: new Date().toISOString() } : {})
    }).where(this.claimPredicate(job)).run();
  }

  nextRetryAt(): number | undefined {
    return this.db.select({ at: memoryExtractionJobs.retryAt }).from(memoryExtractionJobs)
      .where(and(eq(memoryExtractionJobs.status, "pending"), lt(memoryExtractionJobs.attempts, 3)))
      .orderBy(asc(memoryExtractionJobs.retryAt)).limit(1).get()?.at;
  }

  release(job: MemoryExtractionJob): void {
    this.db.update(memoryExtractionJobs).set({
      status: "pending", attempts: Math.max(0, job.attempts - 1),
      startedAt: null, retryAt: 0
    }).where(this.claimPredicate(job)).run();
  }

  cancelOutstanding(): void {
    this.db.update(memoryExtractionJobs).set({ status: "canceled", endedAt: new Date().toISOString() })
      .where(inArray(memoryExtractionJobs.status, ["pending", "running"])).run();
  }

  cancel(job: MemoryExtractionJob): void {
    this.db.update(memoryExtractionJobs).set({ status: "canceled", endedAt: new Date().toISOString() })
      .where(this.claimPredicate(job)).run();
  }

  private claimPredicate(job: MemoryExtractionJob) {
    return and(eq(memoryExtractionJobs.id, job.id), eq(memoryExtractionJobs.status, "running"),
      eq(memoryExtractionJobs.attempts, job.attempts));
  }

  listCandidates(status: "pending" | "accepted" | "rejected" | "auto_saved" = "pending", limit = 100): readonly MemoryCandidateRecord[] {
    return this.db.select().from(memoryCandidates)
      .where(eq(memoryCandidates.status, status))
      .orderBy(asc(memoryCandidates.createdAt))
      .limit(limit).all().map(toCandidateRecord);
  }

  acceptCandidate(id: string, memories: DrizzleMemoryRepository): MemoryCandidateRecord | undefined {
    return this.db.transaction(() => {
      const candidate = this.db.select().from(memoryCandidates).where(and(
        eq(memoryCandidates.id, id), eq(memoryCandidates.status, "pending")
      )).get();
      if (!candidate) return undefined;
      const job = this.db.select().from(memoryExtractionJobs)
        .where(eq(memoryExtractionJobs.id, candidate.jobId)).get();
      if (!job) return undefined;
      if (candidate.action === "ignore") return undefined;

      this.persistCandidate({
        action: candidate.action,
        ...(candidate.targetMemoryId ? { targetMemoryId: candidate.targetMemoryId } : {}),
        ...(candidate.targetRevision !== null ? { targetRevision: candidate.targetRevision } : {}),
        category: candidate.category,
        scopeKey: candidate.scopeKey,
        memoryKey: candidate.memoryKey,
        content: candidate.content,
        confidence: candidate.confidence,
        evidenceMessageIds: parseStringArray(candidate.evidenceMessageIds)
      }, job, memories);
      const updated = this.db.update(memoryCandidates).set({
        status: "accepted",
        decidedAt: new Date().toISOString()
      }).where(eq(memoryCandidates.id, id)).returning().get();
      return updated ? toCandidateRecord(updated) : undefined;
    });
  }

  rejectCandidate(id: string): MemoryCandidateRecord | undefined {
    const updated = this.db.update(memoryCandidates).set({
      status: "rejected",
      decidedAt: new Date().toISOString()
    }).where(and(eq(memoryCandidates.id, id), eq(memoryCandidates.status, "pending")))
      .returning().get();
    return updated ? toCandidateRecord(updated) : undefined;
  }

  private persistCandidate(
    candidate: ExtractedMemoryCandidate,
    job: Pick<MemoryExtractionJob, "sourceRunId" | "sessionId" | "sourceUserMessageId">,
    memories: DrizzleMemoryRepository
  ): void {
    memories.upsertExtracted({
      id: crypto.randomUUID(),
      ...(candidate.targetMemoryId ? { targetMemoryId: candidate.targetMemoryId } : {}),
      ...(candidate.targetRevision !== undefined ? { targetRevision: candidate.targetRevision } : {}),
      content: candidate.content,
      category: candidate.category,
      scopeKey: candidate.scopeKey,
      memoryKey: candidate.memoryKey,
      sourceSessionId: job.sessionId,
      sourceMessageId: job.sourceUserMessageId,
      sourceRunId: job.sourceRunId,
      confidence: candidate.confidence
    });
  }
}
