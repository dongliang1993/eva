# T47 · `run_events` ledger 与 run-scoped recorder

> 前置：无新依赖。读 `00-overview.md` §3 契约 1、2、4、5、8。
> 方案出处：设计文档 §4.2、§4.3、§5.1、§7。

## 1. 问题

现在 telemetry 只有一条出口：Pino（`apps/server/src/observability.ts`）。事件写完就没了 —— 问不出「上一次那个工具为什么慢」、「这个 Run 的 system prompt 当时长什么样」。要回答这些，先得有一张能按 Run 读回来的 append-only 表，以及一个能安全写它的 recorder。

recorder 不是薄封装。它要同时解决四件容易各写一半的事：seq 谁分配、payload 怎么定型、脱敏在哪一层、写失败算谁的。

## 2. 改动

### 2.1 `run_events` 表 + migration

`apps/server/src/db/schema.ts` 新增（`schema.ts` 是唯一事实源，migration 由 drizzle 生成）：

```ts
export const runEventSeverities = ["info", "warn", "error"] as const;

export const runEvents = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    // 冗余列:会话轨迹每页都要先按 session 限定再排序,JOIN runs 再 ORDER BY 用不上索引。
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    agent: text("agent").notNull(),            // "main" | taskId
    kind: text("kind").notNull(),
    turnIndex: integer("turn_index"),
    stepIndex: integer("step_index"),
    attempt: integer("attempt"),
    toolCallId: text("tool_call_id"),
    parentToolCallId: text("parent_tool_call_id"),
    severity: text("severity", { enum: runEventSeverities }).notNull().default("info"),
    payload: text("payload").notNull(),        // 已脱敏、已限长的 canonical JSON
    occurredAtMs: integer("occurred_at_ms").notNull(),
    durationMs: integer("duration_ms")
  },
  (table) => [
    uniqueIndex("uq_run_events_run_seq").on(table.runId, table.seq),
    index("idx_run_events_run_tool_call").on(table.runId, table.toolCallId),
    index("idx_run_events_run_time").on(table.runId, table.occurredAtMs),
    index("idx_run_events_session_time").on(
      table.sessionId, table.occurredAtMs, table.runId, table.seq
    )
  ]
);
```

时间全部 epoch ms。现有 `runs/messages/usage_records` 的 ISO text **不迁移**，两种格式只通过 `run_id` 关联，不做跨表时间运算。

第一版事件 kind（设计文档 §4.2 + §6.1）：

```text
run_started / routing_resolved / skills_selected / request_snapshot
turn_started / turn_completed
step_started / step_completed
model_call_started / model_first_token / model_call_completed / model_call_failed
assistant_message
tool_call_started / tool_call_completed / tool_call_abandoned
approval_asked / approval_decided
tool_call_repaired
context_compacted / context_overflow
loop_transition
operation_abandoned
run_completed / run_failed
```

`tool_call_abandoned` 的 `waited_ms` 落 `duration_ms` 列，payload 带 `decomposed: false` —— 它是未拆分的墙钟时间，不能和 `tool_exec_ms` 混读。

### 2.2 repository

新增 `apps/server/src/db/repositories/run-event-repository.ts`：

- `append(row)` —— 单行同步 insert。
- `listByRun(runId, { beforeSeq, limit })`
- `listBySession(sessionId, { before: { occurredAtMs, runId, seq }, limit })` —— 主 Run 事件（`parent_run_id IS NULL`），三元组游标。better-sqlite3 `^12.8.0` 打的是 SQLite 3.51.3，行值比较 `(a,b,c) < (?,?,?)` 可用，但 drizzle 没有行值构造器，这条走 `sql` 模板。
- `deleteByRun(runId)` / `countByRun(runId)` —— 给 T48 的 retention 用。

### 2.3 run-scoped recorder

新增 `apps/server/src/services/observability/run-recorder.ts`：

```ts
export interface RunRecorder {
  readonly runId: string;
  record(event: RunEventInput): void;   // 同步、不抛
}
export const createRunRecorder = (deps, { runId, sessionId }): RunRecorder => …
```

四条纪律：

1. **seq 由 recorder 独占分配**。实例内一个 `private seq = 0`，分配与 insert 在同一个同步临界段（better-sqlite3 同线程同步写，不需要额外锁）。同一 Run 内主 Agent 与所有前台子代理共用同一个 recorder 实例 —— 这是 `UNIQUE(run_id, seq)` 成立的唯一理由，不许各 Agent 自己计数。
2. **`record` 不抛**。整个函数体包 try/catch，失败只 `logger.warn`。它被 Agent loop 同步调用，抛出去就等于观测把业务打挂了。
3. **payload 定型在 recorder 内**：脱敏 → 截断 → canonical JSON → hash。调用方给普通对象，不给字符串。
4. **`occurredAtMs` 由 recorder 打**，调用方不传时间戳。否则不同调用点的时钟语义会漂。

### 2.4 canonical JSON、hash、脱敏、截断

新增 `apps/server/src/services/observability/redact.ts` + `canonical.ts`：

- canonical JSON：对象键排序、无多余空白 —— hash 要稳定，`request_snapshot_ref` 的同 Run 去重靠它（§4.3）。
- 脱敏（设计文档 §7.2 的最小底线，不多做）：键名命中 `authorization/apiKey/token/password/secret/cookie/set-cookie/privateKey` 替换值；字符串里识别 `Bearer ` 与常见 `sk-` key；单字段超 16 KiB 截断并存 hash、原始字节数、`truncated: true`。
- `capture_level = full` 只表示保留完整业务正文，**凭据规则永远生效**。
- 脱敏器自身抛异常时丢弃整个字段（写 `"[redaction failed]"`），不许 fallback 到原文。
- PEM、JWT、银行卡、邮箱、手机号、bash heredoc 解析、MCP per-tool allowlist 都不进第一版。

### 2.5 设置项

`observability.enabled` / `captureContent`（`off|redacted|full`）/ `retentionDays` / `maxDatabaseBytes` 四个，默认 `true / redacted / 30 / 1073741824`。就这四个 —— 不做采样，理由见设计文档 §7.1。

### 2.6 写入基准（本卡的交付物之一）

新增 `tests/run-events-bench.test.ts`（或 `scripts/`，别混进 CI 阻塞路径）：分别测 metadata-only 事件与最大允许 payload 的 p50/p95/p99 同步写延迟，报告写进卡尾。**只有数据证明同步写影响流式体验，才允许后续引入批处理**；不许先按假设加队列、flush 和 partial 状态机。

## 3. 验收

- 同一 Run 内主 Agent 与两个前台子代理并发发 200 条事件，`UNIQUE(run_id, seq)` 不冲突、seq 连续无空洞、无乱序覆盖。
- `append` 遇到约束冲突/磁盘错误时，调用方拿到的是 `undefined` 而不是异常；Agent loop 继续跑完；Pino 里有一条 warn。
- 默认设置下写入含 `SECRET-TOKEN-123`、`Bearer xxx`、`sk-xxx` 的 payload，落库内容里三者都不出现，且 `truncated`/hash 字段齐全。
- 20 KiB 字段被截断成 16 KiB + hash + `originalBytes`，读回来能看出截断过。
- 脱敏器抛异常时该字段变成占位符，其余字段照常入库。
- 同一份对象两次 canonical + hash 结果相同；键序不同的等价对象 hash 也相同。
- 基准报告给出两档 payload 的 p50/p95/p99。

## 4. 基准报告（2026-08-26，`apps/server/scripts/run-events-bench.ts`，本机 Apple Silicon，WAL + synchronous=NORMAL）

| 负载 | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| metadata-only | 3000 | 0.110 ms | 0.167 ms | 0.382 ms | 1.812 ms |
| 最大 payload（2×20 KiB 字段，触发截断） | 1000 | 0.333 ms | 0.448 ms | 6.506 ms | 12.040 ms |

**结论：不引入批处理/队列。** p50 亚毫秒、p99 个位数毫秒，同步写不会成为流式体验的瓶颈（对照：流式 token 间隔本身就在毫秒级）。维持契约 5 的「同步追加，不建队列」。脚本不在 CI 阻塞路径，复跑：`pnpm exec tsx apps/server/scripts/run-events-bench.ts`。

### 实施备注

- migration 0029 为手写（0023 起 drizzle snapshot 断档，`drizzle-kit generate` 不可用），沿用 0027/0028 的格式 + journal 追加，测试里用真实 DDL 重建表钉住可用性。
- `listBySession` 的「主 Run（`parent_run_id IS NULL`）」过滤等 T48 的列落地后补上（T47 时该列不存在，全部 Run 皆主 Run，过滤器是恒真）。
- `observability` 设置块无 UI：zod 里 optional，`replaceAppSettings` 对未回传的块保留现值而不是重置默认。
- 脱敏键名归一化后**精确匹配**（子串匹配会把 `inputTokens` 这类用量字段误杀），复合变体（`accessToken` 等）与 PEM/JWT 一样不进第一版。
