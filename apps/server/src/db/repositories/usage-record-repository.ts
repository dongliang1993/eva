import { and, asc, eq, gte, lte, sql } from "drizzle-orm";

import type { AppDatabase } from "../index.js";
import { usageRecords } from "../schema.js";

export interface UsageRecordInsert {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly model: string | null;
  /** YYYY-MM-DD(UTC)。settle 时由调用方算好 —— 入账时刻的口径,且测试可注入。 */
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
}

export interface UsageRecordRow extends UsageRecordInsert {
  readonly createdAt: string;
}

export interface DailyUsageRow {
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
}

const toRow = (row: typeof usageRecords.$inferSelect): UsageRecordRow => ({
  id: row.id,
  runId: row.runId,
  sessionId: row.sessionId,
  model: row.model,
  date: row.date,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  reasoningTokens: row.reasoningTokens,
  cachedInputTokens: row.cachedInputTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  totalTokens: row.totalTokens,
  createdAt: row.createdAt
});

/**
 * usage_records 的出入边界。写入由 DrizzleRunRepository.settle 双写驱动
 * (业务入口在 RunLedger);这里不做"何时该写"的判断,只负责写与聚合读。
 */
export class UsageRecordRepository {
  constructor(private readonly db: AppDatabase) { }

  insert(input: UsageRecordInsert): void {
    this.db
      .insert(usageRecords)
      .values({
        id: input.id,
        runId: input.runId,
        sessionId: input.sessionId,
        model: input.model,
        date: input.date,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        reasoningTokens: input.reasoningTokens,
        cachedInputTokens: input.cachedInputTokens,
        cacheWriteTokens: input.cacheWriteTokens,
        totalTokens: input.totalTokens
      })
      .run();
  }

  /** 会话内全部记录(测试与排障用;生产读路径走聚合)。 */
  listBySessionId(sessionId: string): readonly UsageRecordRow[] {
    return this.db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sessionId, sessionId))
      .all()
      .map(toRow);
  }

  /** 该会话的累计用量 —— 五个字段恒为数字(无记录时全零)。 */
  sumBySessionId(sessionId: string): {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly reasoningTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteTokens: number;
  } {
    const row = this.db
      .select({
        inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
        totalTokens: sql<number>`COALESCE(SUM(${usageRecords.totalTokens}), 0)`,
        reasoningTokens: sql<number>`COALESCE(SUM(${usageRecords.reasoningTokens}), 0)`,
        cachedInputTokens: sql<number>`COALESCE(SUM(${usageRecords.cachedInputTokens}), 0)`,
        cacheWriteTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheWriteTokens}), 0)`
      })
      .from(usageRecords)
      .where(eq(usageRecords.sessionId, sessionId))
      .get();

    return {
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      totalTokens: row?.totalTokens ?? 0,
      reasoningTokens: row?.reasoningTokens ?? 0,
      cachedInputTokens: row?.cachedInputTokens ?? 0,
      cacheWriteTokens: row?.cacheWriteTokens ?? 0
    };
  }

  /**
   * 按天聚合(sessionId 为空 = 全局)。未来"用量页"的数据源 ——
   * 这是 runs.usage JSON 做不到的事:date 是列,GROUP BY 一行 SQL。
   */
  sumByDateRange(
    sessionId: string | undefined,
    fromDate: string,
    toDate: string
  ): readonly DailyUsageRow[] {
    const conditions = [
      gte(usageRecords.date, fromDate),
      lte(usageRecords.date, toDate),
      ...(sessionId !== undefined ? [eq(usageRecords.sessionId, sessionId)] : [])
    ];

    return this.db
      .select({
        date: usageRecords.date,
        inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
        reasoningTokens: sql<number>`COALESCE(SUM(${usageRecords.reasoningTokens}), 0)`,
        cachedInputTokens: sql<number>`COALESCE(SUM(${usageRecords.cachedInputTokens}), 0)`,
        cacheWriteTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheWriteTokens}), 0)`,
        totalTokens: sql<number>`COALESCE(SUM(${usageRecords.totalTokens}), 0)`
      })
      .from(usageRecords)
      .where(and(...conditions))
      .groupBy(usageRecords.date)
      .orderBy(asc(usageRecords.date))
      .all();
  }
}
