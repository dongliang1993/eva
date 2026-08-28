import { randomUUID } from "node:crypto";

import { and, count, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { StreamFinishReason, StreamTokenUsage } from "@eva/shared";

import type { AppDatabase } from "../index.js";
import { runs, type RunFailureLayer, type RunStatus } from "../schema.js";
import { UsageRecordRepository } from "./usage-record-repository.js";

export interface RunRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly parentRunId: string | null;
  readonly backgroundTaskId: string | null;
  readonly status: RunStatus;
  readonly requestedModel: string | null;
  readonly model: string | null;
  readonly failureLayer: RunFailureLayer | null;
  readonly captureLevel: string | null;
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
  /** T48 起可选:Run 提前到模型解析前创建,解析成功后 patchRouting 补上。 */
  readonly model?: string;
  /** 子 Run(后台子代理)没有用户消息锚点,可空。 */
  readonly userMessageId?: string;
  readonly requestedModel?: string;
  readonly captureLevel?: string;
  readonly parentRunId?: string;
  readonly backgroundTaskId?: string;
}

export interface SettleRunInput {
  readonly status: Exclude<RunStatus, "running">;
  readonly finishReason?: StreamFinishReason;
  readonly assistantMessageId?: string;
  readonly usage?: StreamTokenUsage;
  readonly error?: string;
  readonly failureLayer?: RunFailureLayer;
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
  parentRunId: row.parentRunId,
  backgroundTaskId: row.backgroundTaskId,
  status: row.status as RunStatus,
  requestedModel: row.requestedModel,
  model: row.model,
  failureLayer: row.failureLayer,
  captureLevel: row.captureLevel,
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
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.userMessageId !== undefined ? { userMessageId: input.userMessageId } : {}),
        ...(input.requestedModel !== undefined ? { requestedModel: input.requestedModel } : {}),
        ...(input.captureLevel !== undefined ? { captureLevel: input.captureLevel } : {}),
        ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
        ...(input.backgroundTaskId !== undefined
          ? { backgroundTaskId: input.backgroundTaskId }
          : {})
      })
      .run();
  }

  /**
   * T48:模型解析成功后回填路由结果。requested/resolved 一次写完 ——
   * 「patchRouting 只写一次」是验收项,这里没有部分更新路径。
   */
  patchRouting(runId: string, requestedModel: string, resolvedModel: string): void {
    this.db
      .update(runs)
      .set({ requestedModel, model: resolvedModel })
      .where(eq(runs.id, runId))
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
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.failureLayer !== undefined ? { failureLayer: input.failureLayer } : {})
        })
        .where(eq(runs.id, runId))
        .run();

      if (input.usage !== undefined) {
        // model/sessionId 从 run 行读(坑 3):settle 时该行已有,调用方拿的不一定一致。
        // T48 提前创建后这条更稳:行在 prepareRunInput 之后就存在了;没有 usage 的
        // 早期失败(routing 炸了)根本不进这个分支。
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

  findById(runId: string): RunRecord | undefined {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .all()
      .map(toRecord)[0];
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
   *
   * T48 起返回被收尾的 run id(不只是数量) —— 启动清扫要接着给它们的 ledger
   * 补 operation_abandoned 事件。
   */
  failStale(): string[] {
    const stale = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "running"))
      .all();
    if (stale.length === 0) {
      return [];
    }

    this.db
      .update(runs)
      .set({
        status: "error",
        error: "server restarted while run was in flight",
        endedAt: new Date().toISOString()
      })
      .where(eq(runs.status, "running"))
      .run();

    return stale.map((row) => row.id);
  }

  /**
   * retention(T48):删掉 endedAt/started_at 早于 cutoff 的终结态 Run。
   * cutoff 是 SQLite datetime 表达式(与 started_at 的 datetime('now') 同基准同格式)。
   * 子 Run 由 parent_run_id 自引用级联带走;run_events 由 run_id 级联带走。
   * @returns 直接命中的行数(级联删除的子 Run 不计入)
   */
  deleteTerminalBefore(cutoffSql: ReturnType<typeof sql>): number {
    return this.db
      .delete(runs)
      .where(and(ne(runs.status, "running"), lt(runs.startedAt, cutoffSql)))
      .run().changes;
  }

  /** retention 容量档:最老的 completed Run 先行。 */
  listOldestCompletedRunIds(limit: number): readonly string[] {
    return this.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "completed"))
      .orderBy(runs.startedAt)
      .limit(limit)
      .all()
      .map((row) => row.id);
  }

  deleteByIds(ids: readonly string[]): number {
    if (ids.length === 0) {
      return 0;
    }
    return this.db.delete(runs).where(inArray(runs.id, [...ids])).run().changes;
  }
}