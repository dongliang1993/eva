# T40 · 接通 cache 五元组 + 新增 cache_write_input_tokens 列

> 前置：`00-overview.md` §2（现状）§3.1（走 SDK 标准字段，不抠 provider metadata）。
> 证据：`LanguageModelUsage.inputTokenDetails.{cacheReadTokens,cacheWriteTokens}` / `outputTokenDetails.reasoningTokens`（ai@7.0.64 index.d.ts:328-358）；Anthropic 适配器实填（@ai-sdk/anthropic index.js:2038-2048）。

## 1. 问题

`usage_records` 的 `cached_input_tokens`/`reasoning_tokens` 两列自 T21 起**永远写 0**，`cache_write_input_tokens` 列干脆不存在。根因：harness 的 usage 链路只取 `inputTokens/outputTokens/totalTokens`，SDK 早已标准化的 cache/reasoning 明细没人读。Alma 记这些是为了精细核算 prompt cache / reasoning 成本——Eva 要复刻就得先把链路接活。

## 2. 改动

### 2.1 harness：`TokenUsage` 加三字段 + `readTokenUsage` 读明细

`packages/harness/src/agents/observer.ts` 的 `TokenUsage`：

```ts
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number;    // cacheReadTokens
  readonly cacheWriteTokens?: number;     // cacheWriteTokens ← 新
  readonly reasoningTokens?: number;      // outputTokenDetails.reasoningTokens
}
```

`agent.ts:103 readTokenUsage`：入参类型放宽到带 `inputTokenDetails`/`outputTokenDetails` 的 SDK `LanguageModelUsage`，读出三个明细字段（`?? undefined`，非 cache 模型不留 0 而是留 undefined，由落库层 `?? 0`）。

`addTokenUsage`（observer.ts）：累加时三个新字段也要累加（`opt + opt`，全 undefined 则保持 undefined）。

### 2.2 shared：`StreamTokenUsage` 加 cacheWrite

`packages/shared/src/stream-events.ts:13`：加 `cacheWriteTokens?: number`（`cachedInputTokens`/`reasoningTokens` 已有声明）。

`agent.ts:79 toStreamTokenUsage`：把 `cachedInputTokens`/`cacheWriteTokens`/`reasoningTokens` 透传进 `StreamTokenUsage`（现在只透 input/output/total）。

### 2.3 server：新增列 + settle 双写

新 migration（`0024_usage_records_cache_write.sql`）：

```sql
ALTER TABLE `usage_records` ADD COLUMN `cache_write_input_tokens` integer NOT NULL DEFAULT 0;
```

`db/schema.ts` 的 `usageRecords` 表加 `cacheWriteTokens` 列定义。

`usage-record-repository.ts`：`NewUsageRecord`/`UsageRecord` 加 `cacheWriteTokens`，INSERT 与 SUM 聚合（`sumBySessionId` 等）都带上。

`run-repository.ts:116 settle` 双写处：`cacheWriteTokens: input.usage.cacheWriteTokens ?? 0`，同时确认 `cachedInputTokens`/`reasoningTokens` 现在能拿到非零值（链路接通后）。

## 3. 涉及文件

修改：

- `packages/harness/src/agents/observer.ts` — `TokenUsage` 三字段 + `addTokenUsage` 累加。
- `packages/harness/src/agents/agent.ts` — `readTokenUsage` 读明细（:103）、`toStreamTokenUsage` 透传（:79）。
- `packages/shared/src/stream-events.ts` — `StreamTokenUsage` 加 `cacheWriteTokens`。
- `apps/server/src/db/schema.ts` — `usageRecords` 加列。
- `apps/server/src/db/repositories/usage-record-repository.ts` — 类型 + INSERT + SUM。
- `apps/server/src/db/repositories/run-repository.ts` — settle 双写加 `cacheWriteTokens`。

新增：

- `apps/server/src/db/migrations/0024_usage_records_cache_write.sql` — ALTER 加列。
- `tests/usage-cache-tokens.test.ts` — 见 §4。

不动 compact/安全网/审批——纯 usage 数据通路。

## 4. 步骤（测试先行）

1. **RED-1（readTokenUsage 读明细）**：构造带 `inputTokenDetails.{cacheReadTokens,cacheWriteTokens}` + `outputTokenDetails.reasoningTokens` 的 SDK usage，断言 `readTokenUsage` 读出三字段；不带则三字段 undefined。红。
2. **RED-2（addTokenUsage 累加）**：两个带明细的 TokenUsage 相加，断言三字段正确累加；一边 undefined 不炸。红。
3. **RED-3（toStreamTokenUsage 透传）**：带明细的 TokenUsage → StreamTokenUsage 含 `cacheWriteTokens` 等。红。
4. **GREEN-1**：实现 §2.1/§2.2，全绿。
5. **RED-4（settle 双写 cache_write）**：settle 带 `cacheWriteTokens` 的 usage → usage_records 行 `cache_write_input_tokens` 非零；SUM 聚合含该列。红（列还不存在）。
6. **GREEN-2**：migration + schema + repository，全绿。
7. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | SDK usage 带 cache 明细 | `readTokenUsage` 读出 cached/cacheWrite/reasoning |
| 2 | SDK usage 不带明细（非 cache 模型） | 三字段 undefined，落库写 0 |
| 3 | 多步累加 | 三字段正确 SUM，单边 undefined 不炸 |
| 4 | settle 带 cacheWrite | usage_records `cache_write_input_tokens` 非零 |
| 5 | **移除实验**：readTokenUsage 不读 cacheWrite | 用例 1/4 转红；恢复全绿 |

E2E：用 Anthropic 模型发一条长上下文消息（触发 prompt cache 写入），查 `usage_records` 该行 `cache_write_input_tokens`/`cached_input_tokens` 有非零值。

## 6. 坑

1. **走 SDK 归一字段，不抠 provider metadata**。`cacheWriteTokens` 是跨 provider 标准出口；`cacheCreationInputTokens` 是 Anthropic 私货，走它就把链路绑死在 Anthropic。
2. **`?? undefined` 在链路里，`?? 0` 在落库**。非 cache 模型留 undefined 而非 0，语义干净；只在 INSERT 时 `?? 0`（列 NOT NULL DEFAULT 0）。
3. **`addTokenUsage` 别漏新字段**——累加器漏一个字段，多步 run 的总量就丢那一项。
4. **ALTER 加列不动旧行**——历史行 `cache_write_input_tokens` 默认 0，不回填（本地单机库，历史用量无决策价值，同 T21 约定）。
5. **inputTokens 口径注意**：SDK 的 `inputTokens`（total）= noCache + cacheRead + cacheWrite（@ai-sdk/anthropic index.js:2040）。落库的 `input_tokens` 沿用现有 `promptTokens` 语义即可，别重复加 cache 项——cache 项是明细，独立列存。
