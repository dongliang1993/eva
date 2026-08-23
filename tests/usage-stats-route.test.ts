/**
 * T41:GET /api/usage/stats 聚合路由。
 * 跨会话按 date+model 分组 SUM 五元组+cache_write,支持 period/date-range/
 * providerId/modelId 过滤。不算 cost(定价表易腐,留扩展口)。
 */
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../apps/server/node_modules/fastify";

import { loadConfig } from "../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import { UsageRecordRepository } from "../apps/server/src/db/repositories/usage-record-repository.js";
import { sessions } from "../apps/server/src/db/schema.js";
import { registerUsageRoutes } from "../apps/server/src/routes/usage.js";

let app: FastifyInstance;
let db: AppDatabase;
let sqlite: Database.Database;

/** 直接插一行 usage_records(绕过 settle,好控制 model/date)。 */
const insertUsage = (row: {
  model: string;
  date: string;
  input?: number;
  output?: number;
  reasoning?: number;
  cached?: number;
  cacheWrite?: number;
  total?: number;
}): void => {
  const runId = randomUUID();
  const sessionId = randomUUID();
  db.insert(sessions).values({ id: sessionId }).run();
  // runs 行是 FK 前提,直接插最简行
  sqlite
    .prepare(
      "INSERT INTO runs (id, session_id, model, status, started_at) VALUES (?, ?, ?, 'completed', datetime('now'))"
    )
    .run(runId, sessionId, row.model);
  sqlite
    .prepare(
      `INSERT INTO usage_records
       (id, run_id, session_id, model, date, input_tokens, output_tokens,
        reasoning_tokens, cached_input_tokens, cache_write_input_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      runId,
      sessionId,
      row.model,
      row.date,
      row.input ?? 0,
      row.output ?? 0,
      row.reasoning ?? 0,
      row.cached ?? 0,
      row.cacheWrite ?? 0,
      row.total ?? 0
    );
};

const stats = async (qs: string) =>
  (await app.inject({ method: "GET", url: `/api/usage/stats${qs}` }));

beforeEach(async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  sqlite = (db as unknown as { $client: Database.Database }).$client;

  app = Fastify();
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    db,
    logger: {} as never,
    skills: []
  });
  app.decorate("services", {} as never);
  registerUsageRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDb(db);
});

describe("UsageRecordRepository.sumByDateAndModel", () => {
  it("多 date/model → 按 date+model 分组,五元组+cache_write 各自 SUM", () => {
    insertUsage({ model: "anthropic:claude-a", date: "2026-08-20", input: 100, total: 100, cacheWrite: 10 });
    insertUsage({ model: "anthropic:claude-a", date: "2026-08-20", input: 50, total: 50, cacheWrite: 5 }); // 同组合并
    insertUsage({ model: "openai:gpt-4o", date: "2026-08-20", input: 7, total: 7 });
    insertUsage({ model: "anthropic:claude-a", date: "2026-08-21", input: 200, total: 200, cached: 30 });

    const rows = new UsageRecordRepository(db).sumByDateAndModel({
      fromDate: "2026-08-20",
      toDate: "2026-08-21"
    });

    expect(rows).toHaveLength(3);
    const day20claude = rows.find((r) => r.date === "2026-08-20" && r.model === "anthropic:claude-a");
    expect(day20claude).toMatchObject({ inputTokens: 150, totalTokens: 150, cacheWriteTokens: 15 });
    const day21 = rows.find((r) => r.date === "2026-08-21");
    expect(day21).toMatchObject({ inputTokens: 200, cachedInputTokens: 30 });
  });

  it("providerId 过滤 → 只剩该 provider(model LIKE 'pid:%')", () => {
    insertUsage({ model: "anthropic:claude-a", date: "2026-08-20", total: 100 });
    insertUsage({ model: "openai:gpt-4o", date: "2026-08-20", total: 50 });

    const rows = new UsageRecordRepository(db).sumByDateAndModel({
      fromDate: "2026-08-01",
      toDate: "2026-08-31",
      providerId: "anthropic"
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe("anthropic:claude-a");
  });

  it("modelId:裸 id 走后缀匹配,全限定走精确", () => {
    insertUsage({ model: "anthropic:claude-a", date: "2026-08-20", total: 100 });
    insertUsage({ model: "openai:claude-a", date: "2026-08-20", total: 50 }); // 同名不同 provider

    const bare = new UsageRecordRepository(db).sumByDateAndModel({
      fromDate: "2026-08-01", toDate: "2026-08-31", modelId: "claude-a"
    });
    expect(bare).toHaveLength(2); // 两家同名都中

    const qualified = new UsageRecordRepository(db).sumByDateAndModel({
      fromDate: "2026-08-01", toDate: "2026-08-31", modelId: "anthropic:claude-a"
    });
    expect(qualified).toHaveLength(1);
    expect(qualified[0]?.model).toBe("anthropic:claude-a");
  });
});

describe("GET /api/usage/stats", () => {
  it("period=day → 返回今天范围,rows 按 date+model 分组,totals=Σrows", async () => {
    const today = new Date().toISOString().slice(0, 10);
    insertUsage({ model: "anthropic:claude-a", date: today, input: 100, output: 50, total: 150, cacheWrite: 20 });
    insertUsage({ model: "anthropic:claude-a", date: today, input: 10, output: 5, total: 15, cacheWrite: 2 });

    const res = await stats("?period=day");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.from).toBe(today);
    expect(body.to).toBe(today);
    expect(body.rows).toHaveLength(1);
    expect(body.totals).toMatchObject({
      inputTokens: 110, outputTokens: 55, totalTokens: 165, cacheWriteTokens: 22
    });
  });

  it("startDate/endDate 覆盖 period", async () => {
    insertUsage({ model: "anthropic:claude-a", date: "2026-08-10", total: 100 }); // 范围内
    insertUsage({ model: "anthropic:claude-a", date: "2026-08-01", total: 50 });  // 范围外

    const res = await stats("?period=year&startDate=2026-08-09&endDate=2026-08-11");
    const body = res.json();
    expect(body.from).toBe("2026-08-09");
    expect(body.rows).toHaveLength(1);
    expect(body.totals.totalTokens).toBe(100);
  });

  it("providerId / modelId 过滤生效", async () => {
    const today = new Date().toISOString().slice(0, 10);
    insertUsage({ model: "anthropic:claude-a", date: today, total: 100 });
    insertUsage({ model: "openai:gpt-4o", date: today, total: 50 });

    const byProvider = (await stats(`?period=day&providerId=openai`)).json();
    expect(byProvider.rows).toHaveLength(1);
    expect(byProvider.rows[0].model).toBe("openai:gpt-4o");

    const byModel = (await stats(`?period=day&modelId=claude-a`)).json();
    expect(byModel.rows).toHaveLength(1);
    expect(byModel.rows[0].model).toBe("anthropic:claude-a");
  });

  it("非法 period → 400;startDate>endDate → 400;坏日期格式 → 400", async () => {
    expect((await stats("?period=fortnight")).statusCode).toBe(400);
    expect((await stats("?startDate=2026-08-31&endDate=2026-08-01")).statusCode).toBe(400);
    expect((await stats("?startDate=08-01-2026")).statusCode).toBe(400);
  });

  it("空库 → rows=[], totals 全 0,不报错", async () => {
    const res = await stats("?period=week");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows).toEqual([]);
    expect(body.totals.totalTokens).toBe(0);
  });
});
