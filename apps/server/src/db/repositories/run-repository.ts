import { and, desc, eq } from "drizzle-orm";
import type { StreamFinishReason, StreamTokenUsage } from "@eva/shared";

import type { AppDatabase } from "../index.js";
import { runs, type RunStatus } from "../schema.js";

export interface RunRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly status: RunStatus;
  readonly model: string | null;
  readonly userMessageId: string | null;
  readonly assistantMessageId: string | null;
  readonly finishReason: string | null;
  readonly usage: StreamTokenUsage | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface StartRunInput {
  readonly id: string;
  readonly sessionId: string;
  readonly model: string;
  readonly userMessageId: string;
}

export interface SettleRunInput {
  readonly status: Exclude<RunStatus, "running">;
  readonly finishReason?: StreamFinishReason;
  readonly assistantMessageId?: string;
  readonly usage?: StreamTokenUsage;
  readonly error?: string;
}

/** finishReason → run 终态。 */
export const runStatusFor = (reason: StreamFinishReason): Exclude<RunStatus, "running"> => {
  switch (reason) {
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    default:
      return "completed";
  }
};

const toRecord = (row: typeof runs.$inferSelect): RunRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  status: row.status as RunStatus,
  model: row.model,
  userMessageId: row.userMessageId,
  assistantMessageId: row.assistantMessageId,
  finishReason: row.finishReason,
  usage: row.usage ? (JSON.parse(row.usage) as StreamTokenUsage) : null,
  error: row.error,
  startedAt: row.startedAt,
  endedAt: row.endedAt
});

export class DrizzleRunRepository {
  constructor(private readonly db: AppDatabase) {}

  start(input: StartRunInput): void {
    this.db
      .insert(runs)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        model: input.model,
        userMessageId: input.userMessageId
      })
      .run();
  }

  settle(runId: string, input: SettleRunInput): void {
    this.db
      .update(runs)
      .set({
        status: input.status,
        endedAt: new Date().toISOString(),
        ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
        ...(input.assistantMessageId !== undefined
          ? { assistantMessageId: input.assistantMessageId }
          : {}),
        ...(input.usage !== undefined ? { usage: JSON.stringify(input.usage) } : {}),
        ...(input.error !== undefined ? { error: input.error } : {})
      })
      .where(eq(runs.id, runId))
      .run();
  }

  findBySessionId(sessionId: string, limit = 50): readonly RunRecord[] {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, sessionId))
      .orderBy(desc(runs.startedAt))
      .limit(limit)
      .all()
      .map(toRecord);
  }

  /** 该会话正在飞的 run(正常只会有 0 或 1 条)。 */
  findRunningBySessionId(sessionId: string): RunRecord | undefined {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.sessionId, sessionId), eq(runs.status, "running")))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .all()
      .map(toRecord)[0];
  }

  /** 所有有 run 在飞的会话 id —— 侧栏列表一次查完,避免 N+1。 */
  listRunningSessionIds(): readonly string[] {
    return this.db
      .select({ sessionId: runs.sessionId })
      .from(runs)
      .where(eq(runs.status, "running"))
      .all()
      .map((row) => row.sessionId);
  }

  /** 该会话所有 run 的 usage 累加(null usage 跳过)。 */
  sumUsageBySessionId(sessionId: string): {
    readonly usage: StreamTokenUsage;
    readonly runCount: number;
  } {
    const rows = this.db
      .select({ usage: runs.usage })
      .from(runs)
      .where(eq(runs.sessionId, sessionId))
      .all();

    const usage: StreamTokenUsage = {};
    let runCount = 0;

    for (const row of rows) {
      runCount += 1;
      if (!row.usage) continue;

      const parsed = JSON.parse(row.usage) as StreamTokenUsage;
      usage.inputTokens = (usage.inputTokens ?? 0) + (parsed.inputTokens ?? 0);
      usage.outputTokens = (usage.outputTokens ?? 0) + (parsed.outputTokens ?? 0);
      usage.totalTokens = (usage.totalTokens ?? 0) + (parsed.totalTokens ?? 0);
      usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (parsed.reasoningTokens ?? 0);
      usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + (parsed.cachedInputTokens ?? 0);
    }

    return { usage, runCount };
  }

  findLastBySessionId(sessionId: string): RunRecord | undefined {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, sessionId))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .all()
      .map(toRecord)[0];
  }

  /**
   * 进程启动时把上次没跑完的 run 收成 error。
   * 没有这一步,崩溃留下的 running 行会永远挂着,runs 表就不可信了。
   * @returns 被收尾的数量
   */
  failStale(): number {
    const result = this.db
      .update(runs)
      .set({
        status: "error",
        error: "server restarted while run was in flight",
        endedAt: new Date().toISOString()
      })
      .where(eq(runs.status, "running"))
      .run();

    return result.changes;
  }
}