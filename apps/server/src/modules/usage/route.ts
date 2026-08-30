import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { UsageStatsRow } from "./api.js";

/**
 * T41:GET /api/usage/stats —— 跨会话/按周期/按模型/provider 的 token 用量聚合。
 * 对齐 Alma(main:101973-102100),但砍了成本计价(定价表易腐,20 §15.4 坑 2)、
 * TTL 缓存与迁移任务(单机库 SUM 毫秒级,无需缓存;T21 起双写无历史包袱)。
 * shape 预留 totalCost 扩展位 —— 将来按 model 查定价表乘 token 即可,不破 API。
 */

const PERIOD_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  period: z.enum(["day", "week", "month", "year"]).optional(),
  startDate: z.string().regex(DATE_RE, "startDate 须为 YYYY-MM-DD").optional(),
  endDate: z.string().regex(DATE_RE, "endDate 须为 YYYY-MM-DD").optional(),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional()
});

/** UTC YYYY-MM-DD —— 与 usage_records.date 列口径一致(settle 时按 UTC 算)。 */
const toUtcDate = (d: Date): string => d.toISOString().slice(0, 10);

const subtractDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return toUtcDate(d);
};

interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
}

/** rows 行数小(date×model),应用层累加即可,不再开一条 SQL。 */
const sumTotals = (rows: readonly UsageStatsRow[]): UsageTotals =>
  rows.reduce<UsageTotals>(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      reasoningTokens: acc.reasoningTokens + r.reasoningTokens,
      cachedInputTokens: acc.cachedInputTokens + r.cachedInputTokens,
      cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      totalTokens: acc.totalTokens + r.totalTokens
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0
    }
  );

export const registerUsageRoutes = (app: FastifyInstance): void => {
  app.get("/api/usage/stats", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? "invalid query" };
    }
    const { period, startDate, endDate, providerId, modelId } = parsed.data;

    // date 列是 UTC,period→range 也必须 UTC,否则「今天」两端对不上(坑 2)。
    const today = toUtcDate(new Date());
    const from = startDate ?? subtractDays(today, (PERIOD_DAYS[period ?? "week"] ?? 7) - 1);
    const to = endDate ?? today;
    if (from > to) {
      reply.code(400);
      return { error: "startDate 不能晚于 endDate" };
    }

    const rows = app.api.usage.statsByDateAndModel({
      fromDate: from,
      toDate: to,
      ...(providerId !== undefined ? { providerId } : {}),
      ...(modelId !== undefined ? { modelId } : {})
    });

    return { from, to, rows, totals: sumTotals(rows) };
  });
};
