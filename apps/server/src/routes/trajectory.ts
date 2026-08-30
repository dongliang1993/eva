import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  RunEventDto,
  RunTrajectoryResponse,
  SessionTrajectoryResponse,
  SubRunSummaryDto
} from "@eva/shared";

import type { RunEventRecord, SubRunSummary } from "../api/observability-api.js";

const limitSchema = z.coerce.number().int().min(1).max(1000).default(200);

const sessionTrajectoryQuerySchema = z
  .object({
    beforeOccurredAtMs: z.coerce.number().int().min(0).optional(),
    beforeRunId: z.string().optional(),
    beforeSeq: z.coerce.number().int().min(0).optional(),
    limit: limitSchema
  })
  .superRefine((query, ctx) => {
    // 游标三元组必须整组给 —— occurredAtMs 定序,runId/seq 是同毫秒 tiebreaker,
    // 只给一部分既不能定序也不能翻页。
    const given = [query.beforeOccurredAtMs, query.beforeRunId, query.beforeSeq]
      .filter((value) => value !== undefined).length;
    if (given !== 0 && given !== 3) {
      ctx.addIssue({
        code: "custom",
        message: "beforeOccurredAtMs/beforeRunId/beforeSeq 必须三个一起给"
      });
    }
  });

/** payload 落库时已是脱敏后的 canonical JSON;读端解析回对象,解析失败保底原样返回。 */
const parsePayload = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const toDto = (row: RunEventRecord): RunEventDto => ({
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
  payload: parsePayload(row.payload),
  occurredAtMs: row.occurredAtMs,
  durationMs: row.durationMs
});

const toSubRunDto = (row: SubRunSummary): SubRunSummaryDto => ({
  runId: row.runId,
  parentRunId: row.parentRunId,
  backgroundTaskId: row.backgroundTaskId,
  subagentType: row.subagentType,
  parentToolCallId: row.parentToolCallId,
  status: row.status as SubRunSummaryDto["status"],
  eventCount: row.eventCount,
  firstOccurredAtMs: row.firstOccurredAtMs,
  lastOccurredAtMs: row.lastOccurredAtMs
});

/** session log 一行:键序固定(JSON.stringify 按插入序),两次导出 byte 相同。
 *  信封 = 身份与排序键(run_id/seq/occurred_at_ms),其余字段收进 data ——
 *  对齐 DSH session.jsonl 的 {type, seq, time, data} 形状。 */
const toLogLine = (row: RunEventRecord): string =>
  JSON.stringify({
    type: "event",
    run_id: row.runId,
    seq: row.seq,
    occurred_at_ms: row.occurredAtMs,
    data: {
      agent: row.agent,
      kind: row.kind,
      turn_index: row.turnIndex,
      step_index: row.stepIndex,
      attempt: row.attempt,
      tool_call_id: row.toolCallId,
      parent_tool_call_id: row.parentToolCallId,
      severity: row.severity,
      duration_ms: row.durationMs,
      payload: parsePayload(row.payload)
    }
  });

/** sessions.created_at 是 ISO text(datetime('now') 或 toISOString 两种) → epoch ms;解析失败返回 undefined(导出头就缺省,不阻塞导出)。 */
const sessionCreatedAtMs = (isoText: string): number | undefined => {
  const normalized = isoText.includes("T") ? isoText : `${isoText.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * S27/T52:轨迹与导出 API。脱敏在写入时已完成(T47),读端不做二次裁剪;
 * 接口不接受任何 capture-level 入参 —— 客户端不能提升抓取级别。
 * 三个接口都不进 loopback token 白名单(loopback.ts 的判定是精确相等,天然豁免)。
 */
export const registerTrajectoryRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/threads/:sessionId/trajectory", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const query = sessionTrajectoryQuerySchema.parse(request.query ?? {});

    if (!app.api.sessions.find(sessionId)) {
      reply.code(404);
      return { error: "session not found" };
    }

    const events = app.api.observability.listSessionEvents(sessionId, {
      ...(query.beforeOccurredAtMs !== undefined &&
        query.beforeRunId !== undefined &&
        query.beforeSeq !== undefined
        ? {
          before: {
            occurredAtMs: query.beforeOccurredAtMs,
            runId: query.beforeRunId,
            seq: query.beforeSeq
          }
        }
        : {}),
      limit: query.limit
    });

    // 满页才可能还有更旧的;不满页即是最后一页。
    const last = events[events.length - 1];
    const response: SessionTrajectoryResponse = {
      events: events.map(toDto),
      subRuns: app.api.observability.summarizeSubRuns(sessionId).map(toSubRunDto),
      nextCursor:
        events.length === query.limit && last !== undefined
          ? {
            beforeOccurredAtMs: last.occurredAtMs,
            beforeRunId: last.runId,
            beforeSeq: last.seq
          }
          : null
    };
    return response;
  });

  app.get("/api/v1/runs/:runId/trajectory", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    // 单 Run 的游标语义就是 seq(严格递增唯一)—— 不给会话级时间游标,不静默半支持。
    const rawQuery = (request.query ?? {}) as Record<string, unknown>;
    if ("beforeOccurredAtMs" in rawQuery || "beforeRunId" in rawQuery) {
      reply.code(400);
      return { error: "单 Run 轨迹只支持 beforeSeq 游标" };
    }
    const query = z
      .object({
        beforeSeq: z.coerce.number().int().min(0).optional(),
        limit: limitSchema
      })
      .parse(rawQuery);

    if (!app.api.observability.runExists(runId)) {
      reply.code(404);
      return { error: "run not found" };
    }

    const events = app.api.observability.listRunEvents(runId, {
      ...(query.beforeSeq !== undefined ? { beforeSeq: query.beforeSeq } : {}),
      limit: query.limit
    });

    const last = events[events.length - 1];
    const response: RunTrajectoryResponse = {
      events: events.map(toDto),
      nextBeforeSeq:
        events.length === query.limit && last !== undefined ? last.seq : null
    };
    return response;
  });

  // session log 导出:首行 session header,后续每条带 run_id + seq,按三元组稳定排序。
  // 直接读持久层(不从 UI 反向拼装);不声称全会话 seq 连续 —— seq 是 Run 级的。
  app.get("/api/v1/threads/:sessionId/session-log", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const session = app.api.sessions.find(sessionId);
    if (!session) {
      reply.code(404);
      return { error: "session not found" };
    }

    const rows = app.api.observability.listAllSessionEvents(sessionId);
    const lines = [
      JSON.stringify({
        type: "session",
        sessionId,
        version: 1,
        // 会话创建时间(epoch ms,对齐 DSH header 的 createdAt)—— 是落库事实,
        // 不是导出时间,两次导出 byte 相同的性质不被它破坏。
        ...(sessionCreatedAtMs(session.createdAt) !== undefined
          ? { createdAt: sessionCreatedAtMs(session.createdAt) }
          : {})
      }),
      ...rows.map(toLogLine)
    ];

    return reply
      .type("application/x-ndjson")
      .header("Content-Disposition", `attachment; filename="session-${sessionId}.jsonl"`)
      .send(lines.join("\n") + "\n");
  });
};
