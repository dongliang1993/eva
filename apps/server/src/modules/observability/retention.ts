import type Database from "better-sqlite3";
import { sql } from "drizzle-orm";

import type { AppDatabase } from "../../db/index.js";
import { DrizzleRunRepository } from "../runs/index.js";

export interface ObservabilityRetentionSettings {
  readonly retentionDays: number;
  readonly maxDatabaseBytes: number;
}

export interface RetentionLogger {
  info(obj: unknown, msg?: string): void;
}

/**
 * 启动清扫第三步(T48):run_events ledger 的保留策略(设计文档 §7.1)。
 *
 * - 按天:started_at 早于 retentionDays 的终结态 Run 整条删除;
 * - 按容量:in-use 字节超 maxDatabaseBytes 时,从最老的 completed Run 开始删。
 *
 * 三条纪律:
 * - 整 Run 粒度删,绝不删活 Run 里的旧事件(request_snapshot_ref 的引用链在 Run 内,
 *   删中间事件会断链);running 状态永远豁免。
 * - 子 Run 由 parent_run_id 自引用级联带走,不能只删父的;run_events 由 run_id 级联带走。
 * - usage_records 的保留策略独立 —— 它的 runs FK 已在 0030 摘掉,这里删 Run 不影响它。
 */
export const applyObservabilityRetention = (
  db: AppDatabase,
  settings: ObservabilityRetentionSettings,
  logger: RetentionLogger
): void => {
  const runs = new DrizzleRunRepository(db);

  // 按天清:cutoff 用 SQLite 自己的 datetime —— 与 started_at 的 datetime('now')
  // 同时钟同格式,不在 JS 侧做字符串日期运算。
  const agedOut = runs.deleteTerminalBefore(
    sql`datetime('now', '-' || ${settings.retentionDays} || ' days')`
  );
  if (agedOut > 0) {
    logger.info(
      { deletedRuns: agedOut, retentionDays: settings.retentionDays },
      "observability retention: aged runs deleted (children cascaded)"
    );
  }

  // 按容量清:in-use 字节 = (page_count - freelist_count) * page_size。
  // 不用文件大小也不用 page_count:删除产生的 freelist 页不归零文件,拿它们当闸门
  // 会被自己的删除骗成死循环。
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  const inUseBytes = (): number => {
    const pageCount = sqlite.pragma("page_count", { simple: true }) as number;
    const freelist = sqlite.pragma("freelist_count", { simple: true }) as number;
    const pageSize = sqlite.pragma("page_size", { simple: true }) as number;
    return (pageCount - freelist) * pageSize;
  };

  let size = inUseBytes();
  let deletedForSize = 0;
  // guard:每批 25 条,上限 400 批(10000 Run)—— 防坏库死循环,正常两轮内就该收敛。
  for (let guard = 0; size > settings.maxDatabaseBytes && guard < 400; guard += 1) {
    const oldest = runs.listOldestCompletedRunIds(25);
    if (oldest.length === 0) {
      break; // 只剩 running / error / aborted —— 都不是容量档该动的。
    }
    deletedForSize += runs.deleteByIds(oldest);
    size = inUseBytes();
  }
  if (deletedForSize > 0) {
    logger.info(
      { deletedRuns: deletedForSize, maxDatabaseBytes: settings.maxDatabaseBytes },
      "observability retention: oldest completed runs deleted for size"
    );
  }
};
