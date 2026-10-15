import { generateText, NoObjectGeneratedError, Output, type LanguageModelUsage } from "ai";
import { z } from "zod";

import { uiMessageText, type AppSettings } from "@eva/shared";
import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { Encryptor } from "../../infrastructure/crypto/encryptor.js";
import { toErrorMessage } from "@eva/shared";
import { resolveModelSlot, toAgentModel } from "../providers/index.js";
import { DrizzleMessageRepository } from "../sessions/index.js";
import { loadAppSettings } from "../settings/index.js";
import {
  MemoryExtractionRepository,
  type ExtractedMemoryCandidate,
  type MemoryExtractionJob
} from "./memory-extraction-repository.js";
import { DrizzleMemoryRepository, type Memory } from "./memory-repository.js";
import {
  recordMemoryRetrieval,
  retrieveMemoriesForRun,
  type MemoryRetrievalResult
} from "./memory-retriever.js";

interface WarnLogger {
  warn(object: unknown, message?: string): void;
}

const candidateSchema = z.object({
  action: z.enum(["create", "update"]),
  targetMemoryId: z.string().optional(),
  category: z.enum(["user", "preference", "project", "decision", "knowledge"]),
  scope: z.enum(["global", "workspace"]),
  memoryKey: z.string().min(3).max(100),
  content: z.string().min(3).max(1000),
  confidence: z.number().int().min(0).max(100)
});

const extractionSchema = z.object({
  candidates: z.array(candidateSchema).max(5)
});

const EXTRACTION_INSTRUCTIONS = [
  "Extract only durable facts that the user explicitly stated in the latest exchange.",
  "Good memories are stable preferences, identity facts, durable project constraints, decisions, or reusable knowledge.",
  "Do not extract tasks, transient status, guesses, assistant claims, secrets, credentials, or the conversation itself.",
  "Use scope=workspace for facts specific to the current project; otherwise use global.",
  "memoryKey must be a stable dotted semantic key such as preference.response_language.",
  "Use action=update and targetMemoryId only when an existing memory clearly represents the same fact.",
  "Return no candidates when nothing is worth remembering."
].join("\n");

const SECRET_PATTERN = /(?:api[_ -]?key|password|passwd|secret|access[_ -]?token|bearer)\s*[:=]\s*\S+|\bsk-[a-z0-9_-]{12,}/i;

const normalizeMemoryKey = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ".")
  .replace(/^\.+|\.+$/g, "")
  .slice(0, 100);

const existingMemoryContext = (items: readonly Memory[]): string => items.length === 0
  ? "(none)"
  : items.map((item) =>
    `- id=${item.id}; scope=${item.scopeKey}; key=${item.memoryKey ?? "(none)"}; ${item.content.slice(0, 300)}`
  ).join("\n");

export interface MemoryExtractionInput {
  readonly job: MemoryExtractionJob;
  readonly abortSignal: AbortSignal;
  readonly userText: string;
  readonly assistantText: string;
  readonly existingMemories: readonly Memory[];
}

export interface MemoryExtractionResult {
  readonly candidates: readonly {
    readonly action: "create" | "update";
    readonly targetMemoryId?: string | undefined;
    readonly category: ExtractedMemoryCandidate["category"];
    readonly scope: "global" | "workspace";
    readonly memoryKey: string;
    readonly content: string;
    readonly confidence: number;
  }[];
  readonly usage?: LanguageModelUsage | undefined;
}

export type ExtractMemories = (input: MemoryExtractionInput) => Promise<MemoryExtractionResult>;

export interface MemoryAutomationDependencies {
  readonly db: AppDatabase;
  readonly config: AppConfig;
  readonly encryptor: Encryptor;
  readonly logger: WarnLogger;
  readonly extract?: ExtractMemories | undefined;
}

export class MemoryAutomationService {
  private readonly memories: DrizzleMemoryRepository;
  private readonly jobs: MemoryExtractionRepository;
  private readonly messages: DrizzleMessageRepository;
  private running: Promise<void> | undefined;
  private rerunRequested = false;
  private closed = false;
  private activeController: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: MemoryAutomationDependencies) {
    this.memories = new DrizzleMemoryRepository(deps.db);
    this.jobs = new MemoryExtractionRepository(deps.db);
    this.messages = new DrizzleMessageRepository(deps.db);
  }

  start() {
    if (this.closed) return;
    const recovered = this.jobs.recoverInterrupted();
    if (recovered > 0) {
      this.deps.logger.warn({ recovered }, "requeued interrupted memory extraction jobs");
    }
    this.wake();
  }

  settingsSnapshot(): AppSettings["memory"] {
    return loadAppSettings(this.deps.db, this.deps.config).memory;
  }

  retrieve(input: {
    readonly query: string;
    readonly workspaceId?: string | undefined;
    readonly settings: AppSettings["memory"];
  }): MemoryRetrievalResult | undefined {
    try {
      return retrieveMemoriesForRun({
        memories: this.memories,
        ...input
      });
    } catch (error) {
      // Recall is enrichment, never a reason to fail the user's run.
      this.deps.logger.warn({ err: error }, "automatic memory retrieval failed");
      return undefined;
    }
  }

  commitRetrieval(runId: string, result: MemoryRetrievalResult | undefined): void {
    if (!result) {
      return;
    }

    try {
      recordMemoryRetrieval(this.deps.db, runId, result);
    } catch (error) {
      this.deps.logger.warn({ err: error, runId }, "could not record retrieved memories");
    }
  }

  enqueue(input: {
    readonly sourceRunId: string;
    readonly sessionId: string;
    readonly workspaceId?: string | undefined;
    readonly sourceUserMessageId: string;
    readonly sourceAssistantMessageId: string;
    readonly modelId: string;
    readonly mode: "review" | "automatic";
  }): boolean {
    if (!this.extractionEnabled()) return false;
    return this.jobs.enqueue({ id: crypto.randomUUID(), ...input });
  }

  private extractionEnabled(): boolean {
    const settings = this.settingsSnapshot();
    return settings.enabled && settings.autoSummarize;
  }

  settingsChanged(): void {
    if (this.closed) return;
    if (!this.extractionEnabled()) {
      this.jobs.cancelOutstanding();
      this.activeController?.abort();
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    } else {
      this.wake();
    }
  }

  wake(): void {
    if (this.closed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = Promise.resolve().then(() => this.drain()).catch((error) => {
      this.deps.logger.warn({ err: error }, "memory extraction worker failed");
    }).finally(() => {
      this.running = undefined;
      if (this.rerunRequested && !this.closed) {
        this.rerunRequested = false;
        this.wake();
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.activeController?.abort();
    await this.running;
  }

  /** Wait for the current worker pass; delayed retries remain scheduled. */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      if (!this.extractionEnabled()) {
        this.jobs.cancelOutstanding();
        return;
      }
      const job = this.jobs.claimNext();
      if (!job) {
        const at = this.jobs.nextRetryAt();
        if (at !== undefined) {
          this.retryTimer = setTimeout(() => this.wake(), Math.max(1, at - Date.now()));
          this.retryTimer.unref();
        }
        return;
      }
      this.activeController = new AbortController();
      try {
        await this.process(job, this.activeController.signal);
      } catch (error) {
        if (this.closed) this.jobs.release(job);
        else if (!this.extractionEnabled()) this.jobs.cancel(job);
        else {
          this.jobs.fail(job, toErrorMessage(error));
          this.deps.logger.warn({ jobId: job.id, runId: job.sourceRunId, attempt: job.attempts }, "memory extraction job failed");
        }
      } finally {
        this.activeController = undefined;
      }
    }
  }

  private async process(job: MemoryExtractionJob, abortSignal: AbortSignal): Promise<void> {
    const user = this.messages.findById(job.sourceUserMessageId);
    const assistant = this.messages.findById(job.sourceAssistantMessageId);
    if (!user || !assistant || user.sessionId !== job.sessionId || assistant.sessionId !== job.sessionId
      || user.role !== "user" || assistant.role !== "assistant") {
      this.jobs.cancel(job);
      return;
    }

    const scopeKeys = job.workspaceId ? [`workspace:${job.workspaceId}`, "global"] : ["global"];
    const existing = this.memories.listActiveInScopes(scopeKeys, "default", 30);
    const result = await (this.deps.extract ?? this.extractWithModel.bind(this))({
      job,
      abortSignal,
      userText: uiMessageText(user.message).slice(0, 12000),
      assistantText: uiMessageText(assistant.message).slice(0, 4000),
      existingMemories: existing
    });
    if (result.usage) this.jobs.recordUsage(job, result.usage);
    abortSignal.throwIfAborted();
    if (!this.extractionEnabled()) {
      this.jobs.cancel(job);
      return;
    }
    // Validate injected extractors too; all candidate writers share this boundary.
    const validated = extractionSchema.parse({ candidates: result.candidates });
    const existingById = new Map(existing.map((memory) => [memory.id, memory]));
    const normalized: ExtractedMemoryCandidate[] = [];
    const seen = new Set<string>();

    for (const candidate of validated.candidates) {
      const content = candidate.content.trim();
      if (!content || SECRET_PATTERN.test(content)) continue;
      const target = candidate.targetMemoryId ? existingById.get(candidate.targetMemoryId) : undefined;
      if (candidate.action === "update" && !target) continue;
      if (candidate.scope === "workspace" && !job.workspaceId) continue;
      const key = normalizeMemoryKey(target?.memoryKey ?? candidate.memoryKey);
      if (key.length < 3) continue;
      const scopeKey = target?.scopeKey ?? (
        candidate.scope === "workspace" && job.workspaceId
          ? `workspace:${job.workspaceId}`
          : "global"
      );
      const identity = `${scopeKey}:${key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      normalized.push({
        action: target ? "update" : "create",
        ...(target ? { targetMemoryId: target.id, targetRevision: target.revision } : {}),
        category: candidate.category,
        scopeKey,
        memoryKey: key,
        content,
        confidence: candidate.confidence,
        evidenceMessageIds: [job.sourceUserMessageId]
      });
    }

    const mode = this.settingsSnapshot().autoSummarizeMode === "review" ? "review" : job.mode;
    this.jobs.complete({ ...job, mode }, normalized, this.memories, result.usage);
  }

  private async extractWithModel(input: MemoryExtractionInput): Promise<MemoryExtractionResult> {
    const resolved = resolveModelSlot(
      this.deps.db,
      this.deps.config,
      "tool",
      input.job.modelId,
      this.deps.encryptor
    );
    if (!resolved.ok) throw new Error(resolved.reason);

    const result = await generateText({
      model: toAgentModel(resolved.binding),
      output: Output.object({ schema: extractionSchema, name: "memory_candidates" }),
      instructions: EXTRACTION_INSTRUCTIONS,
      prompt: [
        `Current workspace: ${input.job.workspaceId ?? "none (do not extract workspace facts)"}`,
        "Existing visible memories:",
        existingMemoryContext(input.existingMemories),
        "",
        "Latest user message (the only authoritative source of new personal facts):",
        input.userText,
        "",
        "Assistant response (context only; do not treat its claims as user facts):",
        input.assistantText.slice(0, 4000)
      ].join("\n"),
      maxOutputTokens: 1200,
      abortSignal: input.abortSignal,
      maxRetries: 0,
      temperature: 0,
      timeout: 30_000
    }).catch((error: unknown) => {
      if (NoObjectGeneratedError.isInstance(error) && error.usage) this.jobs.recordUsage(input.job, error.usage);
      throw error;
    });

    return { candidates: result.output.candidates, usage: result.usage };
  }
}
