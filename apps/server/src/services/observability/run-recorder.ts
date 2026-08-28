import { randomUUID } from "node:crypto";

import type { AppDatabase } from "../../db/index.js";
import { RunEventRepository } from "../../db/repositories/run-event-repository.js";
import type { RunEventSeverity } from "../../db/schema.js";
import { canonicalStringify } from "./canonical.js";
import { redactValue, type CaptureLevel } from "./redact.js";

/** 第一版事件 kind(设计文档 §4.2 + §4.3 + §6.1)。 */
export const runEventKinds = [
  "run_started",
  "routing_resolved",
  "skills_selected",
  "request_snapshot",
  "request_snapshot_ref",
  "turn_started",
  "turn_completed",
  "step_started",
  "step_completed",
  "model_call_started",
  "model_first_token",
  "model_call_completed",
  "model_call_failed",
  "assistant_message",
  "tool_call_started",
  "tool_call_completed",
  "tool_call_abandoned",
  "approval_asked",
  "approval_decided",
  "tool_call_repaired",
  "context_compacted",
  "context_overflow",
  "loop_transition",
  "operation_abandoned",
  "run_completed",
  "run_failed"
] as const;

export type RunEventKind = (typeof runEventKinds)[number];

export interface RunEventInput {
  /** "main" | taskId(前台子代理)。runId 属于绑定关系,不在事件里。 */
  readonly agent: string;
  readonly kind: RunEventKind;
  readonly turnIndex?: number;
  readonly stepIndex?: number;
  readonly attempt?: number;
  readonly toolCallId?: string;
  readonly parentToolCallId?: string;
  readonly severity?: RunEventSeverity;
  /** 普通对象,不给字符串 —— 脱敏/截断/canonical 定型都在 recorder 内完成。 */
  readonly payload?: unknown;
  readonly durationMs?: number;
}

/**
 * Run 级 recorder。四条纪律(00-overview §3 契约 2/4/5):
 * 1. seq 由 recorder 独占单调分配,分配与 insert 在同一同步临界段(better-sqlite3
 *    同线程同步写,不需要额外锁)。同一 Run 的主 Agent 与前台子代理共用一个实例;
 *    后台子代理有自己 Run 的 recorder,seq 从 0 重新开始。
 * 2. record 绝不抛 —— 它被 Agent loop 同步调用,抛出去等于观测把业务打挂。
 * 3. payload 定型在 recorder 内:脱敏 → 截断 → canonical JSON;调用方只给对象。
 * 4. occurredAtMs 由 recorder 打,调用方不传时间戳(不同时钟语义会漂)。
 */
export interface RunRecorder {
  readonly runId: string;
  /** @returns 落库成功的 seq;被禁用或写失败时 undefined。request_snapshot_ref 要它。 */
  record(event: RunEventInput): number | undefined;
}

/** 结构性最小 logger —— pino Logger / FastifyBaseLogger 都天然满足。 */
export interface RunRecorderLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface RunRecorderDeps {
  readonly db: AppDatabase;
  readonly logger: RunRecorderLogger;
  /** settings.observability.enabled —— false 时整条 record 短路。 */
  readonly enabled: boolean;
  readonly captureLevel: CaptureLevel;
}

export interface RunRecorderScope {
  readonly runId: string;
  readonly sessionId: string;
}

export const createRunRecorder = (
  deps: RunRecorderDeps,
  scope: RunRecorderScope
): RunRecorder => {
  const repository = new RunEventRepository(deps.db);
  // seq 从该 Run 现有最大值续起:正常路径是新 Run(从 0 开始);启动清扫为
  // stale Run 补 operation_abandoned 时续在已有事件之后,不撞 UNIQUE(run_id, seq)。
  // 契约 4 不变:同一时刻一个 Run 只有一个活跃 recorder,这个读只是防崩溃重演。
  let seq = 0;
  try {
    seq = (repository.maxSeq(scope.runId) ?? -1) + 1;
  } catch (error) {
    deps.logger.warn(
      { err: error, runId: scope.runId },
      "run recorder seq init failed; starting from 0"
    );
  }

  return {
    runId: scope.runId,
    record(event: RunEventInput): number | undefined {
      if (!deps.enabled) {
        return undefined;
      }
      try {
        // off:正文整条不留,结构列(kind/时间/duration 等)照记。
        const payload =
          deps.captureLevel === "off"
            ? "{}"
            : canonicalStringify(redactValue(event.payload ?? {}, deps.captureLevel));

        repository.append({
          id: randomUUID(),
          runId: scope.runId,
          sessionId: scope.sessionId,
          // 分配与 insert 在同一同步临界段;失败不消耗这个 seq,下条事件递补 ——
          // 失败事件从没落库,就不存在"空洞"。
          seq,
          agent: event.agent,
          kind: event.kind,
          ...(event.turnIndex !== undefined ? { turnIndex: event.turnIndex } : {}),
          ...(event.stepIndex !== undefined ? { stepIndex: event.stepIndex } : {}),
          ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
          ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
          ...(event.parentToolCallId !== undefined
            ? { parentToolCallId: event.parentToolCallId }
            : {}),
          ...(event.severity !== undefined ? { severity: event.severity } : {}),
          payload,
          occurredAtMs: Date.now(),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {})
        });
        seq += 1;
        return seq - 1;
      } catch (error) {
        deps.logger.warn(
          { err: error, runId: scope.runId, kind: event.kind },
          "run event append failed"
        );
        return undefined;
      }
    }
  };
};
