import { desc, eq } from "drizzle-orm";
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