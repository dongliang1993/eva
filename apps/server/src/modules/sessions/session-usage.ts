import type { RunStatus, StreamTokenUsage } from "@eva/shared";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import { DrizzleRunRepository } from "../runs/index.js";
import { resolveModelSlot } from "../providers/index.js";
import { estimateModelHistoryTokens } from "../../lib/token-estimator.js";
import type { SessionService } from "./session.js";
import { DrizzleSessionRepository } from "./session-repository.js";

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

  // 窗口大小来自**这个会话绑定的模型**(sessions.model = 最近一轮 run 选定的),
  // 不是全局设置 —— 主对话模型是 per-thread 的,两个会话可以用不同窗口的模型。
  // 会话还没跑过 run(model 为 null)时没有窗口可言,占用条不显示分母。
  const sessionModel = new DrizzleSessionRepository(db).findById(sessionId)?.model;
  const chat = sessionModel
    ? resolveModelSlot(db, config, "chat", sessionModel)
    : undefined;
  const contextWindow = chat?.ok ? chat.binding.contextWindow ?? null : null;

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
