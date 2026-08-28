import type { AppDatabase } from "../../db/index.js";
import {
  RunEventRepository,
  type RunEventRecord
} from "../../db/repositories/run-event-repository.js";
import { DrizzleRunRepository } from "../../db/repositories/run-repository.js";
import type { CaptureLevel } from "./redact.js";
import { createRunRecorder, type RunRecorderLogger } from "./run-recorder.js";

/**
 * 启动清扫第二步(T48):对 failStale 收成 error 的 Run,为 ledger 里
 * 「有 started 没 completed」的操作追加 operation_abandoned(severity=error)。
 * 历史事实不改写,只追加 —— 崩溃时的在飞工具/模型调用从此在轨迹里可见,
 * 而不是无声消失。
 */

/** started → closer 配对表。key 把同一操作的两个事件归到一组(组内字段缺失用 "?")。 */
const PAIRINGS: ReadonlyArray<{
  readonly started: string;
  readonly closers: readonly string[];
  readonly key: (event: RunEventRecord) => string;
}> = [
  {
    started: "tool_call_started",
    closers: ["tool_call_completed", "tool_call_abandoned"],
    key: (e) => e.toolCallId ?? "?"
  },
  {
    started: "approval_asked",
    closers: ["approval_decided"],
    key: (e) => e.toolCallId ?? "?"
  },
  {
    started: "model_call_started",
    closers: ["model_call_completed", "model_call_failed"],
    key: (e) => `${e.stepIndex ?? "?"}:${e.attempt ?? "?"}`
  },
  {
    started: "step_started",
    closers: ["step_completed"],
    key: (e) => `${e.turnIndex ?? "?"}:${e.stepIndex ?? "?"}`
  },
  {
    started: "turn_started",
    closers: ["turn_completed"],
    key: (e) => `${e.turnIndex ?? "?"}`
  }
];

const closerToStarted = new Map<string, (typeof PAIRINGS)[number]>(
  PAIRINGS.flatMap((pairing) => pairing.closers.map((closer) => [closer, pairing] as const))
);

export const sweepAbandonedOperations = (
  db: AppDatabase,
  logger: RunRecorderLogger,
  captureLevel: CaptureLevel,
  staleRunIds: readonly string[]
): number => {
  if (staleRunIds.length === 0) {
    return 0;
  }

  const events = new RunEventRepository(db);
  const runsRepo = new DrizzleRunRepository(db);
  let appended = 0;

  for (const runId of staleRunIds) {
    const run = runsRepo.findById(runId);
    if (!run) {
      continue;
    }

    // 按 seq 正序重放,started 进 open 表、closer 销账;最后 open 里剩下的就是孤儿。
    const ordered = events.listByRun(runId, { limit: 1_000_000 }).reverse();
    const open = new Map<string, RunEventRecord>();
    for (const event of ordered) {
      const pairing = PAIRINGS.find((candidate) => candidate.started === event.kind);
      if (pairing) {
        open.set(`${event.kind}:${pairing.key(event)}`, event);
        continue;
      }
      const closer = closerToStarted.get(event.kind);
      if (closer) {
        open.delete(`${closer.started}:${closer.key(event)}`);
      }
    }
    if (open.size === 0) {
      continue;
    }

    // recorder 的 seq 从现有最大值续起(createRunRecorder 读 maxSeq),不撞已有事件。
    const recorder = createRunRecorder(
      { db, logger, enabled: true, captureLevel },
      { runId, sessionId: run.sessionId }
    );
    for (const orphan of open.values()) {
      recorder.record({
        agent: orphan.agent,
        kind: "operation_abandoned",
        severity: "error",
        ...(orphan.turnIndex !== null ? { turnIndex: orphan.turnIndex } : {}),
        ...(orphan.stepIndex !== null ? { stepIndex: orphan.stepIndex } : {}),
        ...(orphan.attempt !== null ? { attempt: orphan.attempt } : {}),
        ...(orphan.toolCallId !== null ? { toolCallId: orphan.toolCallId } : {}),
        payload: {
          orphanKind: orphan.kind,
          orphanedAtMs: orphan.occurredAtMs,
          reason: "server restarted while operation was in flight"
        }
      });
      appended += 1;
    }
  }

  return appended;
};
