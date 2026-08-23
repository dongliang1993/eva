import { randomUUID } from "node:crypto";

import { and, count, desc, eq } from "drizzle-orm";
import type { StreamFinishReason, StreamTokenUsage } from "@eva/shared";

import type { AppDatabase } from "../index.js";
import { runs, type RunStatus } from "../schema.js";
import { UsageRecordRepository } from "./usage-record-repository.js";

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
  constructor(private readonly db: AppDatabase) { }

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
    const now = new Date().toISOString();
    // 双写事务:runs.usage 是既有契约(双写过渡,删列留给下下轮),
    // usage_records 是聚合读路径 —— 两处要么都写要么都不写。
    this.db.transaction((tx) => {
      tx.update(runs)
        .set({
          status: input.status,
          endedAt: now,
          ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
          ...(input.assistantMessageId !== undefined
            ? { assistantMessageId: input.assistantMessageId }
            : {}),
          ...(input.usage !== undefined ? { usage: JSON.stringify(input.usage) } : {}),
          ...(input.error !== undefined ? { error: input.error } : {})
        })
        .where(eq(runs.id, runId))
        .run();

      if (input.usage !== undefined) {
        // model/sessionId 从 run 行读(坑 3):settle 时该行已有,调用方拿的不一定一致。
        const runRow = tx
          .select({ model: runs.model, sessionId: runs.sessionId })
          .from(runs)
          .where(eq(runs.id, runId))
          .get();
        if (!runRow) {
          throw new Error(`settle: run ${runId} 不存在,usage 无法入账`);
        }

        new UsageRecordRepository(tx).insert({
          id: randomUUID(),
          runId,
          sessionId: runRow.sessionId,
          model: runRow.model,
          date: now.slice(0, 10), // UTC YYYY-MM-DD(与 started_at 的 datetime('now') 同基准,坑 4)
          inputTokens: input.usage.inputTokens ?? 0,
          outputTokens: input.usage.outputTokens ?? 0,
          reasoningTokens: input.usage.reasoningTokens ?? 0,
          cachedInputTokens: input.usage.cachedInputTokens ?? 0,
          cacheWriteTokens: input.usage.cacheWriteTokens ?? 0,
          totalTokens: input.usage.totalTokens ?? 0
        });
      }
    });
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

  /**
   * 该会话所有 run 的 usage 累加。
   *
   * T21 起改走 usage_records 的 SQL 聚合(不再是 SELECT 全部 JSON 应用层累加)。
   * 注意:启用前的历史 run 在新表无行,累计会少一块 —— 有意为之(不回填,
   * 见 r5 T21 §2.5)。
   *
   * runCount 单独查 runs 表(坑 2):语义是"该会话 run 总数(含无 usage 的)",
   * 不是"有 usage 记录的行数",两个数不能用一个 SQL 糊弄。
   */
  sumUsageBySessionId(sessionId: string): {
    readonly usage: StreamTokenUsage;
    readonly runCount: number;
  } {
    const usage = new UsageRecordRepository(this.db).sumBySessionId(sessionId);
    const runCount =
      this.db
        .select({ value: count() })
        .from(runs)
        .where(eq(runs.sessionId, sessionId))
        .get()?.value ?? 0;

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