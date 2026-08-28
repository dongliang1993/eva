/**
 * T47 写入基准(不进 CI):run_events 同步写路径(recorder 全链路:脱敏 → canonical →
 * 单行 insert)在 metadata-only 与最大 payload 两档下的 p50/p95/p99。
 *
 * 跑法:pnpm exec tsx apps/server/scripts/run-events-bench.ts
 * 判定规则(T47 §2.6):只有数据证明同步写影响流式体验,才允许引入批处理/队列。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { closeDb, initDb, migrateDb } from "../src/db/index.js";
import { runs, sessions } from "../src/db/schema.js";
import { createRunRecorder } from "../src/services/observability/run-recorder.js";

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

const bench = (
  label: string,
  payload: unknown,
  iterations: number
): { p50: number; p95: number; p99: number; max: number; totalMs: number } => {
  const dir = mkdtempSync(path.join(tmpdir(), "run-events-bench-"));
  const db = initDb({ dbPath: path.join(dir, "bench.db") });
  try {
    migrateDb(db);
    db.insert(sessions).values({ id: "s" }).run();
    db.insert(runs).values({ id: "r", sessionId: "s" }).run();

    const recorder = createRunRecorder(
      { db, logger: { warn: (obj) => console.error("warn:", obj) }, enabled: true, captureLevel: "redacted" },
      { runId: "r", sessionId: "s" }
    );

    const samples: number[] = [];
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      recorder.record({ agent: "main", kind: "step_started", stepIndex: i, payload });
      samples.push(performance.now() - t0);
    }
    const totalMs = performance.now() - start;

    samples.sort((a, b) => a - b);
    const report = {
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
      max: samples[samples.length - 1]!,
      totalMs
    };
    console.log(
      `${label} (n=${iterations}): p50=${report.p50.toFixed(3)}ms p95=${report.p95.toFixed(3)}ms ` +
      `p99=${report.p99.toFixed(3)}ms max=${report.max.toFixed(3)}ms total=${report.totalMs.toFixed(0)}ms`
    );
    return report;
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
};

// 热身(页面缓存、WAL 初始化),不计入报告
bench("warmup", { hello: "world" }, 500);

bench("metadata-only", { step: 1, note: "step boundary" }, 3000);

const maxPayload = {
  // 单字段顶到 16 KiB 截断线,外加一层嵌套,模拟最坏的工具入参/输出
  output: "x".repeat(20 * 1024),
  args: { command: "pnpm build", cwd: "/repo", env: { NODE_ENV: "production" } },
  result: { exitCode: 0, stdout: "y".repeat(20 * 1024) }
};
bench("max-payload(2×20KiB 字段)", maxPayload, 1000);
