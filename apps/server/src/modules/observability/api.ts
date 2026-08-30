import type {
  RunEventRecord,
  RunEventRepository,
  SubRunSummary
} from "./run-event-repository.js";
import type { DrizzleRunRepository } from "../runs/index.js";

export type { RunEventRecord, SubRunSummary };

/** 会话级轨迹的游标三元组:occurredAtMs 定序,runId/seq 是同毫秒 tiebreaker。 */
export interface SessionTrajectoryCursor {
  readonly occurredAtMs: number;
  readonly runId: string;
  readonly seq: number;
}

/**
 * S27/T52:轨迹只读投影。
 *
 * 脱敏在写入时已完成(T47),这一层不做二次裁剪,也不接受任何 capture-level 入参 ——
 * 客户端不能提升抓取级别。
 */
export interface ObservabilityApi {
  runExists(runId: string): boolean;
  listSessionEvents(
    sessionId: string,
    options: { readonly before?: SessionTrajectoryCursor; readonly limit: number }
  ): readonly RunEventRecord[];
  /** 导出用:整会话不分页,按 (occurredAtMs, runId, seq) 稳定排序。 */
  listAllSessionEvents(sessionId: string): readonly RunEventRecord[];
  summarizeSubRuns(sessionId: string): readonly SubRunSummary[];
  listRunEvents(
    runId: string,
    options: { readonly beforeSeq?: number; readonly limit: number }
  ): readonly RunEventRecord[];
}

export const createObservabilityApi = (deps: {
  readonly runEvents: RunEventRepository;
  readonly runs: DrizzleRunRepository;
}): ObservabilityApi => ({
  runExists: (runId) => deps.runs.findById(runId) !== undefined,
  listSessionEvents: (sessionId, options) => deps.runEvents.listBySession(sessionId, options),
  listAllSessionEvents: (sessionId) => deps.runEvents.listAllBySession(sessionId),
  summarizeSubRuns: (sessionId) => deps.runEvents.summarizeSubRuns(sessionId),
  listRunEvents: (runId, options) => deps.runEvents.listByRun(runId, options)
});
