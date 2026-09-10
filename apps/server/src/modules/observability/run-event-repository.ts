import { and, count, desc, eq, lt, max, sql } from "drizzle-orm";

import type { AppDatabase } from "../../db/index.js";
import { runEvents, type RunEventSeverity } from "../../db/schema.js";

export interface RunEventRecord {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly agent: string;
  readonly kind: string;
  readonly turnIndex: number | null;
  readonly stepIndex: number | null;
  readonly attempt: number | null;
  readonly toolCallId: string | null;
  readonly parentToolCallId: string | null;
  readonly severity: RunEventSeverity;
  /** 已脱敏、已限长的 canonical JSON 原文 —— 解析留给读路径。 */
  readonly payload: string;
  readonly occurredAtMs: number;
  readonly durationMs: number | null;
}

export interface AppendRunEventInput {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly agent: string;
  readonly kind: string;
  readonly turnIndex?: number;
  readonly stepIndex?: number;
  readonly attempt?: number;
  readonly toolCallId?: string;
  readonly parentToolCallId?: string;
  readonly severity?: RunEventSeverity;
  /** 必须已是定型后的 canonical JSON(脱敏/截断在 recorder 内完成),这里不再碰内容。 */
  readonly payload: string;
  readonly occurredAtMs: number;
  readonly durationMs?: number;
}

/** 会话级游标三元组:occurredAtMs 定序,runId/seq 只做同毫秒内的稳定 tiebreaker。 */
export interface SessionEventCursor {
  readonly occurredAtMs: number;
  readonly runId: string;
  readonly seq: number;
}

const toRecord = (row: typeof runEvents.$inferSelect): RunEventRecord => ({
  id: row.id,
  runId: row.runId,
  sessionId: row.sessionId,
  seq: row.seq,
  agent: row.agent,
  kind: row.kind,
  turnIndex: row.turnIndex,
  stepIndex: row.stepIndex,
  attempt: row.attempt,
  toolCallId: row.toolCallId,
  parentToolCallId: row.parentToolCallId,
  severity: row.severity,
  payload: row.payload,
  occurredAtMs: row.occurredAtMs,
  durationMs: row.durationMs
});

const DEFAULT_LIMIT = 200;

export class RunEventRepository {
  constructor(private readonly db: AppDatabase) { }

  /** 单行同步 insert。抛错处理是调用方(recorder)的责任。 */
  append(row: AppendRunEventInput): void {
    this.db
      .insert(runEvents)
      .values({
        id: row.id,
        runId: row.runId,
        sessionId: row.sessionId,
        seq: row.seq,
        agent: row.agent,
        kind: row.kind,
        turnIndex: row.turnIndex,
        stepIndex: row.stepIndex,
        attempt: row.attempt,
        toolCallId: row.toolCallId,
        parentToolCallId: row.parentToolCallId,
        severity: row.severity ?? "info",
        payload: row.payload,
        occurredAtMs: row.occurredAtMs,
        durationMs: row.durationMs
      })
      .run();
  }

  /**
   * 单 Run 事件页:seq < beforeSeq(缺省 = 从尾部取最新一页)。
   * 返回按 seq 倒序(最新在前);要时间正序的调用方自己 reverse。
   */
  listByRun(
    runId: string,
    options: { beforeSeq?: number; limit?: number } = {}
  ): RunEventRecord[] {
    const conditions = [eq(runEvents.runId, runId)];
    if (options.beforeSeq !== undefined) {
      conditions.push(lt(runEvents.seq, options.beforeSeq));
    }

    return this.db
      .select()
      .from(runEvents)
      .where(and(...conditions))
      .orderBy(desc(runEvents.seq))
      .limit(options.limit ?? DEFAULT_LIMIT)
      .all()
      .map(toRecord);
  }

  /**
   * 会话事件页:三元组游标 (occurredAtMs, runId, seq) < before,按三元组倒序返回
   * (最新在前)。行值比较走 sql 模板 —— drizzle 没有行值构造器;索引由
   * idx_run_events_session_time 支撑。
   */
  listBySession(
    sessionId: string,
    options: { before?: SessionEventCursor; limit?: number } = {}
  ): RunEventRecord[] {
    const conditions = [eq(runEvents.sessionId, sessionId)];
    if (options.before !== undefined) {
      const before = options.before;
      conditions.push(
        sql`(${runEvents.occurredAtMs}, ${runEvents.runId}, ${runEvents.seq}) < (${before.occurredAtMs}, ${before.runId}, ${before.seq})`
      );
    }

    return this.db
      .select()
      .from(runEvents)
      .where(and(...conditions))
      .orderBy(desc(runEvents.occurredAtMs), desc(runEvents.runId), desc(runEvents.seq))
      .limit(options.limit ?? DEFAULT_LIMIT)
      .all()
      .map(toRecord);
  }

  /** recorder 的 seq 续接点:新 Run 是 null(从 0 开始),启动清扫补事件时续在已有之后。 */
  maxSeq(runId: string): number | null {
    return (
      this.db
        .select({ value: max(runEvents.seq) })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get()?.value ?? null
    );
  }

  /**
   * 会话全部事件,按三元组升序 —— session-log 导出用。
   */
  listAllBySession(sessionId: string): RunEventRecord[] {
    return this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.sessionId, sessionId))
      .orderBy(runEvents.occurredAtMs, runEvents.runId, runEvents.seq)
      .all()
      .map(toRecord);
  }

  /** retention 用:整 Run 粒度删,绝不删活 Run 里的旧事件(snapshot ref 链会断)。 */
  deleteByRun(runId: string): number {
    return this.db.delete(runEvents).where(eq(runEvents.runId, runId)).run().changes;
  }

  countByRun(runId: string): number {
    return (
      this.db
        .select({ value: count() })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get()?.value ?? 0
    );
  }

}
