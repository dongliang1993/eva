# r10 · S20 usage_records 补全（cache_write 链路 + /api/usage/stats 聚合）

> 切片编号 **S20**，来源 `docs/architecture/11-landing-plan.md` §3.5。
> 前置阅读：20 §15（usage 计量三件套）/ 04 §8.7（usage_records DDL + saveUsageRecord）/ 14 §7.2 / 16 §3.3-6。
> Alma 证据行号：`main:NNNNN` = Alma bundle；`eva:` = 本仓库文件。

## 1. 目标

Eva 已有 `usage_records` 表雏形（T21，0023 migration），但**列是空壳**——`cached_input_tokens`/`reasoning_tokens` 永远在写 0，因为 harness 的 usage 链路压根没读这几个字段。本轮：

1. **接通 cache 五元组**：把 SDK v7 已标准化的 `inputTokenDetails.{cacheReadTokens,cacheWriteTokens}` + `outputTokenDetails.reasoningTokens` 接进 harness 的 `TokenUsage` 链路，让 `cached_input`/`reasoning` 写非零，并**新增 `cache_write_input_tokens` 列**接 `cacheWriteTokens`。
2. **新增 `GET /api/usage/stats` 聚合路由**：按 `period`/`startDate/endDate`/`providerId`/`modelId` 聚合，按 date+model 分组 SUM 五元组（Alma main:101973-102100）。

## 2. 现状盘点（代码实证）

| 能力 | 现状 | 位置 |
|---|---|---|
| usage_records 表 | ✅ 已有，含 `cached_input_tokens`/`reasoning_tokens` 列 | `eva:apps/server/src/db/migrations/0023_usage_records.sql` |
| `cache_write_input_tokens` 列 | ❌ 无（T21 砍了，注释「SDK 不暴露」） | 本轮 T40 加列 |
| SDK 是否暴露 cache_write | ✅ **暴露**——`LanguageModelUsage.inputTokenDetails.cacheWriteTokens`（ai@7.0.64 index.d.ts:340）；Anthropic 适配器实填 `inputTokens.cacheWrite = cache_creation_input_tokens`（@ai-sdk/anthropic index.js:2043） | 已核实 |
| harness 是否读 cache/reasoning | ❌ **没读**——`readTokenUsage` 只取 input/output/total | `eva:packages/harness/src/agents/agent.ts:103` |
| `StreamTokenUsage` 是否带 cache_write | ❌ 只到 `cachedInputTokens`/`reasoningTokens`（且没人填） | `eva:packages/shared/src/stream-events.ts:13` |
| 单会话 usage 聚合 | ✅ `GET /api/v1/threads/:id/usage` | `eva:apps/server/src/routes/threads.ts:233` |
| 全局 `/api/usage/stats` | ❌ 无 | 本轮 T41 |
| 成本计价（定价表） | ❌ 无 | **本轮砍掉**（见 §3.4） |

**结论：S20 不是建表（已有），是 ① 把链路里漏读的 cache/reasoning 字段接活 + 补 cache_write 列 ② 加全局聚合路由。两处都是增量，不动表主体。**

## 3. 执行契约

1. **数据源是 SDK 标准字段，不是 provider metadata**。`cacheWriteTokens`/`cacheReadTokens`/`reasoningTokens` 是 `LanguageModelUsage` 的归一字段（SDK 内部已把 Anthropic 的 `cache_creation_input_tokens` 等映射好）。**别去抠 provider metadata / `cacheCreationInputTokens`**——那是 Alma 直读 Anthropic 响应的做法，Eva 走 SDK 就用 SDK 的归一出口，跨 provider 还免费。
2. **非 Anthropic provider 这些字段是 `undefined`**，落库写 0（与现有 `?? 0` 一致），不报错。链路上每一步都要 `?? 0` / `?? undefined` 容错。
3. **聚合按列 SUM，不解析 JSON**（20 §15.4 坑 1）——这正是分列的意义。索引已铺（date / model / session）。
4. **本轮不算 cost**。Alma 的 stats 带定价表算 `totalCost`，但定价表是易腐数据（20 §15.4 坑 2），单机本地用量先做「量」不做「钱」。路由 shape 留出 `totalCost` 扩展位，首版返回 token 聚合即可。
5. **TTL 缓存 / 迁移任务（`usage_migration_status`）砍掉**——单机库 SUM 几张表不需要缓存；Eva 没有「旧 metadata 零散用量」要迁（T21 起就双写，无历史包袱）。

## 4. 任务卡

| 卡 | 文件 | 一句话 | 估时 | 依赖 |
|---|---|---|---|---|
| **T40** | `T40-cache-write-usage-pipeline.md` | 接通 cache 五元组：`TokenUsage`/`StreamTokenUsage`/`readTokenUsage` 加 cacheWrite/cached/reasoning，新增 `cache_write_input_tokens` 列 + settle 双写 | 0.5–1 天 | — |
| **T41** | `T41-usage-stats-route.md` | `GET /api/usage/stats`：period/date-range/provider/model 入参，按 date+model 分组 SUM 五元组（不算 cost，留扩展位） | 0.5 天 | T40（要有非零数据才有得聚合） |

**顺序**：T40 先（数据通路是 T41 的前提——没有非零的 cache_write，stats 聚合出来的全是 0 没法验）。串行：T40 → T41。

## 5. 验收总表

| 卡 | 一句话验收 |
|---|---|
| T40 | 一次带 cache 的对话后（Anthropic 模型+长上下文触发 prompt cache），`usage_records` 行含 `cached_input`/`cache_write_input`/`reasoning` 非零值 |
| T41 | `curl '/api/usage/stats?period=day'` 返回按 date+model 分组的五元组聚合；带 `providerId`/`modelId`/`startDate/endDate` 过滤生效 |

S20 切片全绿 = T40–T41 全绿 + 11 §3.5 S20 两条验收过。
