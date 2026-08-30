import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { runs, sessions, usageRecords } from "../../../apps/server/src/db/schema.js";
import { RunEventRepository } from "../../../apps/server/src/modules/observability/index.js";
import { DrizzleRunRepository } from "../../../apps/server/src/modules/runs/index.js";
import { canonicalStringify, sha256Hex } from "../../../apps/server/src/modules/observability/index.js";
import {
  MAX_FIELD_BYTES,
  REDACTED,
  redactValue
} from "../../../apps/server/src/modules/observability/index.js";
import {
  createRunRecorder,
  type RunRecorderLogger
} from "../../../apps/server/src/modules/observability/index.js";
import { sweepAbandonedOperations } from "../../../apps/server/src/modules/observability/index.js";
import { applyObservabilityRetention } from "../../../apps/server/src/modules/observability/index.js";

const createLogger = (): RunRecorderLogger & { warnings: unknown[] } => {
  const warnings: unknown[] = [];
  return {
    warnings,
    warn(obj: unknown) {
      warnings.push(obj);
    }
  };
};

const seedRun = (db: AppDatabase, runId: string, sessionId: string): void => {
  db.insert(sessions).values({ id: sessionId }).onConflictDoNothing().run();
  db.insert(runs).values({ id: runId, sessionId }).run();
};

const rawClient = (db: AppDatabase): import("better-sqlite3").Database =>
  (db as unknown as { $client: import("better-sqlite3").Database }).$client;

describe("run_events ledger(T47)", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("同一 Run 内主 Agent 与两个前台子代理交错发 200 条:seq 连续无空洞、无冲突", () => {
    seedRun(db, "run-1", "session-1");
    const recorder = createRunRecorder(
      { db, logger: createLogger(), enabled: true, captureLevel: "redacted" },
      { runId: "run-1", sessionId: "session-1" }
    );
    const agents = ["main", "task-1", "task-2"];

    for (let i = 0; i < 200; i += 1) {
      recorder.record({
        agent: agents[i % agents.length]!,
        kind: "step_started",
        stepIndex: i
      });
    }

    const repo = new RunEventRepository(db);
    expect(repo.countByRun("run-1")).toBe(200);
    const seqs = repo
      .listByRun("run-1", { limit: 500 })
      .map((row) => row.seq)
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it("insert 抛错时 record 返回 undefined 不抛、warn 进 logger、失败不消耗 seq", () => {
    seedRun(db, "run-1", "session-1");
    const logger = createLogger();
    const recorder = createRunRecorder(
      { db, logger, enabled: true, captureLevel: "redacted" },
      { runId: "run-1", sessionId: "session-1" }
    );

    rawClient(db).exec("DROP TABLE run_events");
    expect(() =>
      recorder.record({ agent: "main", kind: "run_started" })
    ).not.toThrow();
    expect(logger.warnings.length).toBe(1);

    // 用真实 migration DDL 把表建回来 —— 顺带钉住 migration 本身可用。
    const ddl = readFileSync(
      "apps/server/src/db/migrations/0029_run_events.sql",
      "utf8"
    );
    for (const statement of ddl.split("--> statement-breakpoint")) {
      const sql = statement.trim();
      if (sql.length > 0) {
        rawClient(db).exec(sql);
      }
    }

    recorder.record({ agent: "main", kind: "run_started" });
    recorder.record({ agent: "main", kind: "run_completed" });

    const rows = new RunEventRepository(db).listByRun("run-1", { limit: 10 });
    expect(rows.map((row) => row.seq).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("默认 redacted 档:SECRET-TOKEN-123 / Bearer / sk- 与敏感键值都不落库", () => {
    seedRun(db, "run-1", "session-1");
    const recorder = createRunRecorder(
      { db, logger: createLogger(), enabled: true, captureLevel: "redacted" },
      { runId: "run-1", sessionId: "session-1" }
    );

    recorder.record({
      agent: "main",
      kind: "tool_call_started",
      payload: {
        secret: "SECRET-TOKEN-123",
        apiKey: "SECRET-TOKEN-123",
        headers: { authorization: "Bearer abc.def.ghi" },
        note: "use Bearer tok12345 then key sk-abcdefgh123",
        nested: { list: [{ password: "hunter2" }] },
        harmless: "inputTokens 这类字段必须活着"
      }
    });

    const [row] = new RunEventRepository(db).listByRun("run-1", { limit: 1 });
    expect(row).toBeDefined();
    const raw = row!.payload;
    expect(raw).not.toContain("SECRET-TOKEN-123");
    expect(raw).not.toContain("abc.def.ghi");
    expect(raw).not.toContain("tok12345");
    expect(raw).not.toContain("sk-abcdefgh123");
    expect(raw).not.toContain("hunter2");

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["secret"]).toBe(REDACTED);
    expect(parsed["apiKey"]).toBe(REDACTED);
    expect((parsed["headers"] as Record<string, unknown>)["authorization"]).toBe(REDACTED);
    expect(parsed["note"]).toBe("use Bearer [REDACTED] then key [REDACTED]");
    expect(
      (parsed["nested"] as { list: unknown[] })["list"]
    ).toEqual([{ password: REDACTED }]);
    expect(parsed["harmless"]).toBe("inputTokens 这类字段必须活着");
  });

  it("20 KiB 字段被截断成 16 KiB + sha256 + originalBytes + truncated 标记", () => {
    seedRun(db, "run-1", "session-1");
    const recorder = createRunRecorder(
      { db, logger: createLogger(), enabled: true, captureLevel: "redacted" },
      { runId: "run-1", sessionId: "session-1" }
    );
    const big = "x".repeat(20 * 1024);

    recorder.record({ agent: "main", kind: "assistant_message", payload: { big } });

    const [row] = new RunEventRepository(db).listByRun("run-1", { limit: 1 });
    const parsed = JSON.parse(row!.payload) as {
      big: { truncated: boolean; originalBytes: number; sha256: string; preview: string };
    };
    expect(parsed.big.truncated).toBe(true);
    expect(parsed.big.originalBytes).toBe(20 * 1024);
    expect(parsed.big.sha256).toBe(sha256Hex(big));
    expect(Buffer.byteLength(parsed.big.preview, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    // 读回来能认出截断过 —— preview 不含完整原文
    expect(parsed.big.preview).not.toBe(big);
  });

  it("脱敏器异常:该字段变占位符,其余字段照常;循环引用同理", () => {
    const evil = {
      ok: "fine",
      get boom(): string {
        throw new Error("getter exploded");
      }
    };
    const redacted = redactValue(evil, "redacted") as Record<string, unknown>;
    expect(redacted["ok"]).toBe("fine");
    expect(redacted["boom"]).toBe("[redaction failed]");

    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;
    // 循环引用按字段级兜底:炸的是 self 这个字段,a 的其余字段照常
    const redactedCircular = redactValue({ a: circular, b: 1 }, "redacted") as Record<
      string,
      unknown
    >;
    expect(redactedCircular["a"]).toEqual({ name: "loop", self: "[redaction failed]" });
    expect(redactedCircular["b"]).toBe(1);
  });

  it("canonical JSON:同对象两次相同;键序不同的等价对象 hash 相同", () => {
    const a = { b: 1, a: { d: [3, 2], c: "x" } };
    const b = { a: { c: "x", d: [3, 2] }, b: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(a));
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    expect(sha256Hex(canonicalStringify(a))).toBe(sha256Hex(canonicalStringify(b)));
    // 数组顺序是语义,不参与键排序
    expect(canonicalStringify({ d: [3, 2] })).not.toBe(canonicalStringify({ d: [2, 3] }));
  });

  it("captureContent=off 落空 payload;full 不截断但凭据规则仍生效", () => {
    seedRun(db, "run-1", "session-1");
    seedRun(db, "run-2", "session-1");
    // 注意:一个 Run 只能有一个 recorder(契约 4)。两档 capture level 用两条 Run 测。
    const offLogger = createLogger();
    const off = createRunRecorder(
      { db, logger: offLogger, enabled: true, captureLevel: "off" },
      { runId: "run-1", sessionId: "session-1" }
    );
    off.record({ agent: "main", kind: "run_started", payload: { anything: "goes" } });

    const fullLogger = createLogger();
    const full = createRunRecorder(
      { db, logger: fullLogger, enabled: true, captureLevel: "full" },
      { runId: "run-2", sessionId: "session-1" }
    );
    const big = "y".repeat(20 * 1024);
    full.record({
      agent: "main",
      kind: "assistant_message",
      payload: { big, key: "sk-abcdefgh123" }
    });
    expect(offLogger.warnings).toEqual([]);
    expect(fullLogger.warnings).toEqual([]);

    const [offRow] = new RunEventRepository(db).listByRun("run-1", { limit: 1 });
    expect(JSON.parse(offRow!.payload)).toEqual({});
    const [fullRow] = new RunEventRepository(db).listByRun("run-2", { limit: 1 });
    const fullPayload = fullRow!.payload;
    expect(fullPayload).toContain(big); // full 不截断
    expect(fullPayload).not.toContain("sk-abcdefgh123"); // 凭据规则永远生效
  });

  it("observability.enabled=false 时整条 record 短路", () => {
    seedRun(db, "run-1", "session-1");
    const recorder = createRunRecorder(
      { db, logger: createLogger(), enabled: false, captureLevel: "redacted" },
      { runId: "run-1", sessionId: "session-1" }
    );
    recorder.record({ agent: "main", kind: "run_started" });
    expect(new RunEventRepository(db).countByRun("run-1")).toBe(0);
  });

  it("listByRun:beforeSeq 翻页,倒序返回,无重复无丢失", () => {
    seedRun(db, "run-1", "session-1");
    const recorder = createRunRecorder(
      { db, logger: createLogger(), enabled: true, captureLevel: "redacted" },
      { runId: "run-1", sessionId: "session-1" }
    );
    for (let i = 0; i < 10; i += 1) {
      recorder.record({ agent: "main", kind: "step_started", stepIndex: i });
    }

    const repo = new RunEventRepository(db);
    expect(repo.listByRun("run-1", { limit: 3 }).map((r) => r.seq)).toEqual([9, 8, 7]);
    expect(repo.listByRun("run-1", { beforeSeq: 7, limit: 3 }).map((r) => r.seq)).toEqual([6, 5, 4]);
    expect(repo.listByRun("run-1", { beforeSeq: 4, limit: 10 }).map((r) => r.seq)).toEqual([3, 2, 1, 0]);
    expect(repo.listByRun("run-1", { beforeSeq: 0, limit: 3 })).toEqual([]);
  });

  it("listBySession:三元组游标跨 Run 翻页,同毫秒 tiebreak 稳定", () => {
    seedRun(db, "run-a", "session-1");
    // 第二条 Run 同 session
    db.insert(runs).values({ id: "run-b", sessionId: "session-1" }).run();

    const repo = new RunEventRepository(db);
    const append = (
      runId: string,
      seq: number,
      occurredAtMs: number
    ): void =>
      repo.append({
        id: `${runId}-${seq}`,
        runId,
        sessionId: "session-1",
        seq,
        agent: "main",
        kind: "step_started",
        payload: "{}",
        occurredAtMs
      });

    // 同毫秒跨 Run:靠 runId + seq 定序
    append("run-a", 0, 100);
    append("run-a", 1, 100);
    append("run-b", 0, 100);
    append("run-a", 2, 200);
    append("run-b", 1, 300);

    // 倒序(新在前):300/run-b/1, 200/run-a/2, 100/run-b/0, 100/run-a/1, 100/run-a/0
    const page1 = repo.listBySession("session-1", { limit: 2 });
    expect(page1.map((r) => [r.occurredAtMs, r.runId, r.seq])).toEqual([
      [300, "run-b", 1],
      [200, "run-a", 2]
    ]);

    const cursor1 = page1[page1.length - 1]!;
    const page2 = repo.listBySession("session-1", {
      before: { occurredAtMs: cursor1.occurredAtMs, runId: cursor1.runId, seq: cursor1.seq },
      limit: 2
    });
    expect(page2.map((r) => [r.occurredAtMs, r.runId, r.seq])).toEqual([
      [100, "run-b", 0],
      [100, "run-a", 1]
    ]);

    const cursor2 = page2[page2.length - 1]!;
    const page3 = repo.listBySession("session-1", {
      before: { occurredAtMs: cursor2.occurredAtMs, runId: cursor2.runId, seq: cursor2.seq },
      limit: 5
    });
    expect(page3.map((r) => [r.occurredAtMs, r.runId, r.seq])).toEqual([[100, "run-a", 0]]);

    // 三页拼起来 = 全量,无重复
    const all = [...page1, ...page2, ...page3].map((r) => r.id);
    expect(new Set(all).size).toBe(5);
  });
});


describe("启动清扫:operation_abandoned(T48)", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("stale Run 的未闭合 started 各补一条 operation_abandoned,已配对的一条不动", () => {
    seedRun(db, "run-stale", "session-1");
    const repo = new RunEventRepository(db);
    const append = (
      seq: number,
      kind: string,
      fields: Partial<{
        toolCallId: string;
        turnIndex: number;
        stepIndex: number;
        attempt: number;
      }> = {}
    ): void =>
      repo.append({
        id: `e-${seq}`,
        runId: "run-stale",
        sessionId: "session-1",
        seq,
        agent: "main",
        kind,
        payload: "{}",
        occurredAtMs: 1000 + seq,
        ...fields
      });

    append(0, "run_started");
    append(1, "tool_call_started", { toolCallId: "call-1" }); // 未闭合 → 孤儿
    append(2, "tool_call_started", { toolCallId: "call-2" });
    append(3, "tool_call_completed", { toolCallId: "call-2" }); // 已配对
    append(4, "model_call_started", { stepIndex: 1, attempt: 1 }); // 未闭合 → 孤儿
    append(5, "turn_started", { turnIndex: 0 });
    append(6, "turn_completed", { turnIndex: 0 }); // 已配对

    const staleIds = new DrizzleRunRepository(db).failStale();
    expect(staleIds).toEqual(["run-stale"]);

    const logger = createLogger();
    const appended = sweepAbandonedOperations(db, logger, "redacted", staleIds);
    expect(appended).toBe(2);
    expect(logger.warnings).toEqual([]);

    const all = repo.listByRun("run-stale", { limit: 100 }).reverse();
    const abandoned = all.filter((row) => row.kind === "operation_abandoned");
    expect(abandoned).toHaveLength(2);
    // seq 续接在已有最大值之后
    expect(abandoned.map((row) => row.seq)).toEqual([7, 8]);
    expect(abandoned.every((row) => row.severity === "error")).toBe(true);

    const orphanKinds = abandoned.map((row) => {
      const payload = JSON.parse(row.payload) as { orphanKind: string };
      return payload.orphanKind;
    });
    expect(orphanKinds).toEqual(["tool_call_started", "model_call_started"]);
    // tool_call 孤儿回挂原 toolCallId,轨迹投影能认亲
    expect(abandoned[0]!.toolCallId).toBe("call-1");

    // 总数 = 原 7 条 + 补 2 条;没有任何已配对事件被改写或重复补发
    expect(all).toHaveLength(9);
    expect(all.filter((row) => row.kind === "tool_call_abandoned")).toHaveLength(0);
  });

  it("全部已配对的 stale Run 不补任何事件", () => {
    seedRun(db, "run-stale", "session-1");
    const repo = new RunEventRepository(db);
    repo.append({
      id: "e-0",
      runId: "run-stale",
      sessionId: "session-1",
      seq: 0,
      agent: "main",
      kind: "step_started",
      payload: "{}",
      occurredAtMs: 1000
    });
    repo.append({
      id: "e-1",
      runId: "run-stale",
      sessionId: "session-1",
      seq: 1,
      agent: "main",
      kind: "step_completed",
      payload: "{}",
      occurredAtMs: 1001
    });

    const staleIds = new DrizzleRunRepository(db).failStale();
    const appended = sweepAbandonedOperations(db, createLogger(), "redacted", staleIds);
    expect(appended).toBe(0);
    expect(repo.countByRun("run-stale")).toBe(2);
  });
});

describe("retention(T48)", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  const logger = { info: () => {} };

  const seedTerminalRun = (
    runId: string,
    sessionId: string,
    options: { startedAt: string; status?: string; parentRunId?: string }
  ): void => {
    db.insert(sessions).values({ id: sessionId }).onConflictDoNothing().run();
    db.insert(runs)
      .values({
        id: runId,
        sessionId,
        status: (options.status ?? "completed") as "completed",
        startedAt: options.startedAt,
        endedAt: options.startedAt,
        ...(options.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {})
      })
      .run();
  };

  const seedEvent = (runId: string, sessionId: string, seq: number): void => {
    new RunEventRepository(db).append({
      id: `${runId}-e-${seq}`,
      runId,
      sessionId,
      seq,
      agent: "main",
      kind: "run_started",
      payload: "{}",
      occurredAtMs: 1000
    });
  };

  it("retentionDays=0:过期 Run 及子 Run 全清,usage_records 不受影响,外键不留孤儿", () => {
    seedTerminalRun("parent", "s-1", { startedAt: "2026-08-01 00:00:00" });
    seedTerminalRun("child", "s-1", { startedAt: "2026-08-01 00:01:00", parentRunId: "parent" });
    seedTerminalRun("fresh", "s-1", { startedAt: "2026-08-01 00:02:00", status: "running" });
    seedEvent("parent", "s-1", 0);
    seedEvent("child", "s-1", 0);
    seedEvent("fresh", "s-1", 0);
    db.insert(usageRecords)
      .values({ id: "u-1", runId: "parent", sessionId: "s-1", date: "2026-08-01", totalTokens: 42 })
      .run();

    applyObservabilityRetention(db, { retentionDays: 0, maxDatabaseBytes: 1 << 30 }, logger);

    const runsRepo = new DrizzleRunRepository(db);
    const eventsRepo = new RunEventRepository(db);
    // 父与子整条没了(子由 parent_run_id 级联),running 豁免
    expect(runsRepo.findById("parent")).toBeUndefined();
    expect(runsRepo.findById("child")).toBeUndefined();
    expect(runsRepo.findById("fresh")).toBeDefined();
    // 事件随 run 级联清,外键不留孤儿
    expect(eventsRepo.countByRun("parent")).toBe(0);
    expect(eventsRepo.countByRun("child")).toBe(0);
    expect(eventsRepo.countByRun("fresh")).toBe(1);
    // usage_records 保留策略独立 —— 0030 摘 FK 就是为了让这一行活着
    const usage = db.select().from(usageRecords).all();
    expect(usage).toHaveLength(1);
    expect(usage[0]!.totalTokens).toBe(42);
  });

  it("容量超限:从最老 completed 开始删,running 不动", () => {
    seedTerminalRun("old", "s-1", { startedAt: "2026-08-20 00:00:00" });
    seedTerminalRun("mid", "s-1", { startedAt: "2026-08-21 00:00:00" });
    seedTerminalRun("live", "s-1", { startedAt: "2026-08-22 00:00:00", status: "running" });
    seedEvent("old", "s-1", 0);
    seedEvent("mid", "s-1", 0);
    seedEvent("live", "s-1", 0);

    // maxDatabaseBytes=1:in-use 永远超标 → 删光 completed 后收敛(running 不是容量档该动的)。
    applyObservabilityRetention(
      db,
      { retentionDays: 10_000, maxDatabaseBytes: 1 },
      logger
    );

    const runsRepo = new DrizzleRunRepository(db);
    expect(runsRepo.findById("old")).toBeUndefined();
    expect(runsRepo.findById("mid")).toBeUndefined();
    expect(runsRepo.findById("live")).toBeDefined();
    expect(new RunEventRepository(db).countByRun("live")).toBe(1);
  });
});
