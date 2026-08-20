# T21 · usage_records 独立表

> 前置：无。开工前读 `../r1/00-overview.md` §1（尤其 §1.5 迁移是手写 SQL + 手写 journal）+ `00-overview.md` §1.6、§3。
> 施工图：`docs/architecture/04-model-adapter-agent-harness.md` §8.7.1（完整 schema 实证）。

**建议 1 个 commit**：`feat(server)` —— 迁移 + 表 + 写入路径 + 聚合读路径切换，一次落齐。

---

## 1. 问题实证

`apps/server/src/db/schema.ts:192`：

```ts
/** StreamTokenUsage JSON。 */
usage: text("usage"),
```

一次 run 的 token 消耗整体塞在 `runs.usage` JSON 列里。唯一的聚合消费方 `sumUsageBySessionId`（`run-repository.ts:127`）的实现是：**把该会话所有 run 的 JSON 全部 SELECT 出来，应用层循环 `JSON.parse` 再累加**。

做不到的（JSON 内部 SQL 进不去）：

- 按天聚合（"这周烧了多少"）—— 没有 `date` 列；
- 按模型聚合（"哪个模型在烧钱"）—— `runs.model` 有，但和 token 数在两处，GROUP BY 要 JSON 展开；
- prompt-cache 成本核算 —— `cached_input_tokens` 命中与未命中的价格差 10 倍（Anthropic），混在一个数字里就是一笔糊涂账。

Alma 的 `usage_records`（`docs 04 §8.7.1` 实证 schema）：`message_id / thread_id / model / provider_id / date / input / output / cached_input / cache_write_input / reasoning / total / timestamp / created_at`。按天 GROUP BY 是一行 SQL。

---

## 2. 目标设计

### 2.1 表结构（0023 迁移）

照 Alma schema 裁剪到 Eva 的实体命名（`threads→sessions`、`chat_messages→messages`）与现有六列 `StreamTokenUsage`：

```sql
CREATE TABLE `usage_records` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `runs`(`id`) ON DELETE CASCADE,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  /** "providerId:modelId" —— 与 runs.model 同源,冗余进本表免得聚合时 JOIN。 */
  `model` text,
  /** YYYY-MM-DD(UTC) —— 按天聚合的 GROUP BY 键。 */
  `date` text NOT NULL,
  `input_tokens` integer NOT NULL DEFAULT 0,
  `output_tokens` integer NOT NULL DEFAULT 0,
  `reasoning_tokens` integer NOT NULL DEFAULT 0,
  `cached_input_tokens` integer NOT NULL DEFAULT 0,
  `total_tokens` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_usage_records_session` ON `usage_records` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_usage_records_date` ON `usage_records` (`date`);
--> statement-breakpoint
CREATE INDEX `idx_usage_records_model` ON `usage_records` (`model`);
```

> **偏离 Alma 的两处**：
> 1. **砍掉 `cache_write_input_tokens`**。Eva 的 `StreamTokenUsage`（`packages/shared`）只有五列，AI SDK 的 `LanguageModelUsage` 目前不暴露 cache-write；为一列拿不到的数据预留字段，正是 R2 T8 §2.1 否掉的"为不存在的概念留字段"。SDK 哪天真暴露了，加列是 `ALTER TABLE` 一行的事。
> 2. **`run_id` 取代 `message_id`**。Eva 的 usage 天然归属 run（settle 时才知道总数），`assistantMessageId` 在 `runs` 表上，要 JOIN 消息从那里走，不为 Alma 的挂法硬造第二份关联。

journal 追加 `{ "idx": 23, "version": "6", "when": <now-ms>, "tag": "0023_usage_records", "breakpoints": true }`。

### 2.2 写入路径：settle 时双写

`RunLedger.settle`（`services/runs/run-ledger.ts`）是唯一写 usage 的业务入口（`routes/runs.ts:177`）。在 `DrizzleRunRepository.settle` 里：

```
UPDATE runs SET usage = <json> ...        ← 旧列,保留(双写过渡)
INSERT INTO usage_records (...)           ← 新表,当且仅当 input.usage 非空
```

**双写而不是切换**：`runs.usage` 是既有契约（`RunRecord.usage` 被 `session-usage.ts` 等消费），新表先证明自己，删列留给下下轮（`00-overview.md` §2.1-6）。一次 `settle` 里写两处用同一个事务（better-sqlite3 同步 API 天然单连接顺序执行，`db.transaction` 包一下即可）。

`date` 列在 settle 时算（`new Date().toISOString().slice(0, 10)`）—— 不让 SQL 默认值算，因为 settle 时刻才是"这笔消耗入账"的时刻，且测试可注入。

### 2.3 读路径：聚合改走新表

`sumUsageBySessionId` 重写为 SQL 聚合：

```sql
SELECT
  COALESCE(SUM(input_tokens), 0)  AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(total_tokens), 0)  AS totalTokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
  COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
  COUNT(*) AS runCount            ← 注意:这是"有 usage 的 run 数",见 §6 坑 2
FROM usage_records
WHERE session_id = ?
```

**一致性校验**（验收用，不是常驻代码）：新旧路径对同一会话跑一遍，五个字段必须相等 —— 写进测试（§4 Step 3）。

### 2.4 新增按天聚合查询（只建机制，不做 UI）

`usage-record-repository.ts`（新文件）加 `sumByDateRange(sessionId | undefined, fromDate, toDate)` —— 返回按 `date` GROUP BY 的行数组。这是未来"用量页"的数据源；本任务只把查询能力与测试建好（`00-overview.md` §2.1-5：UI 不做）。

### 2.5 历史数据不回填

`runs.usage` 里的历史 JSON 不批量迁进 `usage_records`。理由与 T19 懒迁移同款：本地单机库，历史 usage 没有决策价值（它只是"过去花了多少"，不影响任何行为）；为一次性数据写迁移脚本 + 测试不值。新表从启用那天起有数据，按天聚合的曲线从那天起画。**`sumUsageBySessionId` 改走新表后，历史 run 的 usage 会从这个接口的返回里消失** —— 这是有意的（见 §6 坑 1 的说明与缓解）。

---

## 3. 涉及文件

### 新增
| 文件 | 内容 |
|---|---|
| `apps/server/src/db/migrations/0023_usage_records.sql` | §2.1 |
| `apps/server/src/db/repositories/usage-record-repository.ts` | `insert` + `sumBySessionId` + `sumByDateRange` |
| `tests/usage-records.test.ts` | §4 全部用例 |

### 修改
| 文件 | 动作 |
|---|---|
| `apps/server/src/db/schema.ts` | `usageRecords` 表定义 |
| `apps/server/src/db/migrations/meta/_journal.json` | idx 23 条目 |
| `apps/server/src/db/repositories/run-repository.ts` | `settle` 双写（事务）；`sumUsageBySessionId` 改走新表 |
| `apps/server/src/services/runs/run-ledger.ts` | 透传 settle 需要的 model（`runs.model` 已有，从 run 行读，不加参数 —— 见 §6 坑 3） |

---

## 4. 步骤

### Step 1 · 迁移 + schema

`0023_usage_records.sql` + journal 条目 + `schema.ts` 表定义。`pnpm typecheck` 绿（无测试改动）。

### Step 2 · 【测试先行】双写与新聚合

`tests/usage-records.test.ts`（内存 DB + `migrateDb`，照 `tests/agent-runtime.test.ts`）：

- `settle(runId, { usage: {...} })` → `runs.usage` JSON 在（回归）**且** `usage_records` 多一行：六列数值一致、`model` 与 run 行一致、`date` 是今天（注入时钟或断言格式）；
- `settle` 不带 usage（aborted/error 无 usage 的场景）→ `usage_records` **不插行**；
- 同一事务性：`usage_records` 插入失败（构造唯一键冲突）→ `runs.usage` 也没更新（回滚）。

RED（表不存在）→ 实现 → GREEN。

### Step 3 · 【测试先行】聚合等价 + 按天聚合

- 跑 3 个 run（两个带 usage、一个不带）→ 新 `sumUsageBySessionId` 的五个累加字段 = 手工 JSON 累加（旧实现逻辑在测试里复刻一份做对照）；
- `sumByDateRange`：跨三天各塞一条 → GROUP BY 出三行、日期升序、合计正确；空范围返回空数组（不抛）。

### Step 4 · 接线

`run-ledger.ts` / `session-usage.ts` 消费方确认（`session-usage.ts` 不改代码 —— 它调的 `sumUsageBySessionId` 签名不变，内部实现换了）。`pnpm typecheck && pnpm test` 全绿。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；`tests/usage-records.test.ts` RED→GREEN
- [ ] 手工：聊一轮 → `sqlite3 ~/.eva/eva.db "select date, model, input_tokens, output_tokens, cached_input_tokens from usage_records order by rowid desc limit 3"` 有行
- [ ] 手工：`select date, sum(total_tokens) from usage_records group by date` 一条 SQL 出按天合计（旧 JSON 路径做不到的事）
- [ ] 手工回归：`GET /threads/:id/usage` 返回结构与数值正常（`session-usage.ts` 消费方无感切换）
- [ ] 迁移幂等：已有 `~/.eva/eva.db` 的实例启动 → journal 追加 0023、表建好、历史数据不动

## 6. 坑

1. **`sumUsageBySessionId` 改走新表 = 历史 usage "消失"**。启用前的 run 在新表无行，会话累计会"变少"。这是有意接受的（§2.5），但要在 commit 正文写明 —— 否则下次有人看累计数字会以为出了 bug。缓解：该接口的 UI 语义是"这个会话烧了多少"，新装/新会话为主，历史会话的累计少一块不影响功能。
2. **`runCount` 语义漂移**。旧实现 `runCount` = 该会话 run 总数（含无 usage 的）；新 SQL 里 `COUNT(*)` = 有 usage 记录的行数。aborted run 没 usage —— 两个数会不等。修法：`runCount` 单独 `SELECT COUNT(*) FROM runs WHERE session_id=?`（一行 SQL，别为省一次查询让语义撒谎）。
3. **model 字段的来源**。`usage_records.model` 从 **run 行**读（`runs.model`，settle 时该行已有），不要从 `SettleRunInput` 加参数透传 —— 调用方（route）拿的不一定和 run 行一致，多一个参数就多一处不一致的可能。repository 内部 `select model from runs where id=?` 顺带取。
4. **`date` 用本地时区**。`new Date().toISOString()` 是 UTC —— 保持 UTC（与 `started_at` 的 `datetime('now')` 同基准），别用本地时区切片，否则跨时区开发/旅行的按天聚合会错乱。
5. **顺手删 `runs.usage` 列**。`00-overview.md` §2.1-6 明确不删；双写期至少跑一轮（R6）确认新表数据可信后再议。现在删 = 同时改 `RunRecord` 契约 + 全部消费方，一个任务变两个。
