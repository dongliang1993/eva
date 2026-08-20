import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { DrizzleRunRepository } from "../apps/server/src/db/repositories/run-repository.js";
import { UsageRecordRepository } from "../apps/server/src/db/repositories/usage-record-repository.js";
import { sessions } from "../apps/server/src/db/schema.js";

const seedSession = (db: AppDatabase, id: string): void => {
  db.insert(sessions).values({ id }).run();
};

/** 起一个 run 并按给定选项收尾。 */
const settleRun = (
  repo: DrizzleRunRepository,
  sessionId: string,
  settle?: Parameters<DrizzleRunRepository["settle"]>[1]
): string => {
  const runId = randomUUID();
  repo.start({ id: runId, sessionId, model: "openai:gpt-4o", userMessageId: randomUUID() });
  repo.settle(runId, settle ?? { status: "completed", assistantMessageId: randomUUID() });
  return runId;
};

describe("usage_records 双写", () => {
  const setup = () => {
    const db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    return { db, runs: new DrizzleRunRepository(db), usage: new UsageRecordRepository(db) };
  };

  it("settle 带 usage → runs.usage JSON 在(回归)且 usage_records 多一行", () => {
    const { db, runs, usage } = setup();
    seedSession(db, "s1");

    const runId = settleRun(runs, "s1", {
      status: "completed",
      assistantMessageId: randomUUID(),
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 30 }
    });

    const run = runs.findLastBySessionId("s1");
    expect(run?.usage?.inputTokens).toBe(100); // 旧列回归

    const rows = usage.listBySessionId("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId,
      sessionId: "s1",
      model: "openai:gpt-4o", // 从 run 行读,不从入参传
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 0,
      cachedInputTokens: 30
    });
    expect(rows[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // UTC YYYY-MM-DD
  });

  it("settle 不带 usage(aborted/error)→ usage_records 不插行", () => {
    const { db, runs, usage } = setup();
    seedSession(db, "s1");

    settleRun(runs, "s1", { status: "aborted" });

    expect(usage.listBySessionId("s1")).toHaveLength(0);
  });
});

describe("sumUsageBySessionId 改走新表", () => {
  const setup = () => {
    const db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    return { db, runs: new DrizzleRunRepository(db) };
  };

  it("聚合等价:两个带 usage 的 run + 一个不带 → 五字段 = 手工 JSON 累加", () => {
    const { db, runs } = setup();
    seedSession(db, "s1");

    settleRun(runs, "s1", {
      status: "completed",
      assistantMessageId: randomUUID(),
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 10 }
    });
    settleRun(runs, "s1", {
      status: "completed",
      assistantMessageId: randomUUID(),
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 320, reasoningTokens: 20 }
    });
    settleRun(runs, "s1", { status: "aborted" }); // 无 usage

    const { usage, runCount } = runs.sumUsageBySessionId("s1");

    expect(usage).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 470,
      reasoningTokens: 20,
      cachedInputTokens: 10
    });
    // runCount 语义不漂移:该会话 run 总数(含无 usage 的),不是 usage_records 行数
    expect(runCount).toBe(3);
  });

  it("无 usage 的会话 → 全零,runCount 仍是 run 总数", () => {
    const { db, runs } = setup();
    seedSession(db, "s1");
    settleRun(runs, "s1", { status: "aborted" });

    const { usage, runCount } = runs.sumUsageBySessionId("s1");
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0
    });
    expect(runCount).toBe(1);
  });
});

describe("sumByDateRange 按天聚合", () => {
  const setup = () => {
    const db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    return { db, usage: new UsageRecordRepository(db) };
  };

  it("跨三天 → GROUP BY 三行、日期升序、合计正确", () => {
    const { db, usage } = setup();
    seedSession(db, "s1");

    // 走真实 settle 路径(FK 要求 run 存在),再直接改 date 列构造跨天分布
    const runsRepo = new DrizzleRunRepository(db);
    const sqlite = (db as unknown as { $client: Database.Database }).$client;
    const insert = (date: string, total: number) => {
      const runId = settleRun(runsRepo, "s1", {
        status: "completed",
        assistantMessageId: randomUUID(),
        usage: { inputTokens: total, outputTokens: 0, totalTokens: total }
      });
      sqlite.prepare("UPDATE usage_records SET date = ? WHERE run_id = ?").run(date, runId);
    };

    insert("2026-08-18", 100);
    insert("2026-08-19", 200);
    insert("2026-08-19", 50); // 同一天两条 → 合并
    insert("2026-08-20", 300);

    const rows = usage.sumByDateRange("s1", "2026-08-18", "2026-08-20");
    expect(rows.map((r) => r.date)).toEqual(["2026-08-18", "2026-08-19", "2026-08-20"]);
    expect(rows.map((r) => r.totalTokens)).toEqual([100, 250, 300]);
  });

  it("空范围 → 空数组(不抛)", () => {
    const { usage } = setup();
    expect(usage.sumByDateRange("nobody", "2026-01-01", "2026-01-31")).toEqual([]);
  });
});
