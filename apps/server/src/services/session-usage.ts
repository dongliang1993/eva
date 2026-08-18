import type { RunStatus, StreamTokenUsage } from "@eva/shared";

import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import { DrizzleRunRepository } from "../db/repositories/run-repository.js";
import { resolveModelSlot } from "./providers/model-resolver.js";
import { estimateModelHistoryTokens } from "./token-estimator.js";
import type { SessionService } from "./session.js";

export interface SessionUsage {
  readonly contextTokens: number;
  readonly contextWindow: number | null;
  readonly contextRatio: number | null;
  readonly runCount: number;
  readonly totalUsage: StreamTokenUsage;
  readonly lastRun: {
    readonly id: string;
    readonly status: RunStatus;
    readonly finishReason: string | null;
    readonly endedAt: string | null;
  } | null;
}

/**
 * 上下文占用 = 模型这一轮实际会看到的历史(含 compaction 摘要)的估算,
 * 不是 messages 表的全量 —— 用户关心的是"离下一次 compact 还有多远"。
 */
export const readSessionUsage = (
  db: AppDatabase,
  config: AppConfig,
  session: SessionService,
  sessionId: string
): SessionUsage => {
  const history = session.buildModelHistory(db, sessionId);
  const contextTokens = estimateModelHistoryTokens(history);

  const chat = resolveModelSlot(db, config, "chat");
  const contextWindow = chat.ok ? chat.binding.contextWindow ?? null : null;

  const runRepo = new DrizzleRunRepository(db);
  const { usage: totalUsage, runCount } = runRepo.sumUsageBySessionId(sessionId);
  const lastRun = runRepo.findLastBySessionId(sessionId);

  return {
    contextTokens,
    contextWindow,
    contextRatio: contextWindow !== null ? contextTokens / contextWindow : null,
    runCount,
    totalUsage,
    lastRun: lastRun
      ? {
        id: lastRun.id,
        status: lastRun.status,
        finishReason: lastRun.finishReason,
        endedAt: lastRun.endedAt
      }
      : null
  };
};