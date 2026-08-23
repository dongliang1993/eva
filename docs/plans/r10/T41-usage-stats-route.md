# T41 · GET /api/usage/stats 聚合路由

> 前置：T40（要有非零 cache_write 数据才有得聚合）。`00-overview.md` §3.3-3.5（按列 SUM / 不算 cost / 砍缓存迁移）。
> Alma 证据：`GET /api/usage/stats`（main:101973-102100），`period=day|week|month|year` 或 `startDate/endDate`，过滤 providerId/modelId。
> 现状抓手：`UsageRecordRepository.sumByDateRange` 已能按天 SUM（`eva:usage-record-repository.ts:115`），缺 provider 列、缺按 model 分组、缺路由。

## 1. 问题

Eva 只有单会话用量（`GET /api/v1/threads/:id/usage`），没有全局视图。「这周哪个模型烧了多少 token / cache 命中率多少」答不上来——这正是 Alma stats 端点解决的事。表和 SUM 原语都有，缺一个跨会话、可按周期/模型/provider 过滤的聚合出口。

## 2. 改动

### 2.1 repository：加按 date+model 分组的聚合

`usage-record-repository.ts` 加方法（复用 sumByDateRange 的 SQL 套路）：

```ts
export interface UsageStatsRow {
  readonly date: string;
  readonly model: string | null;         // "providerId:modelId"
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;     // T40 加的列
  readonly totalTokens: number;
}

sumByDateAndModel(opts: {
  fromDate: string;
  toDate: string;
  providerId?: string;   // 用 model LIKE 'providerId:%' 过滤(无独立 provider_id 列)
  modelId?: string;      // 用 model LIKE '%:modelId' 或 = 精确值
}): readonly UsageStatsRow[]
```

实现要点：
- `GROUP BY date, model`，`ORDER BY date, model`。
- providerId 过滤：`sql\`${usageRecords.model} LIKE ${providerId + ':%'}\``（`model` 是 `"providerId:modelId"` 冗余列，无独立 provider_id 列——这是 T21 定的口径，不为其加列）。
- modelId 过滤：入参给的是裸 modelId 就 `LIKE '%:' + modelId`，给的是 `"pid:mid"` 全限定就 `=` 精确匹配。
- 五元组 + cache_write 各列 `COALESCE(SUM(...), 0)`。

### 2.2 路由：`GET /api/usage/stats`

新建 `apps/server/src/routes/usage.ts`，`registerUsageRoutes(app)` 注册进 `routes/index.ts`（static 之前）。

```
GET /api/usage/stats?period=day|week|month|year
                    &startDate=YYYY-MM-DD&endDate=YYYY-MM-DD   # 与 period 互斥,显式 range 优先
                    &providerId=xxx&modelId=yyy
```

- **period → date range**：`day`=今天，`week`=近 7 天，`month`=近 30 天，`year`=近 365 天（UTC，与 `date` 列口径一致）。`startDate/endDate` 给了就覆盖 period。
- 默认 `period=week`（不带参数给个有用的默认）。
- 返回：

```json
{
  "from": "2026-08-17", "to": "2026-08-23",
  "rows": [ { "date": "...", "model": "...", "inputTokens": 0, "...": 0 } ],
  "totals": { "inputTokens": 0, "outputTokens": 0, "reasoningTokens": 0,
              "cachedInputTokens": 0, "cacheWriteTokens": 0, "totalTokens": 0 }
}
```

- `totals` 是 rows 的应用层累加（行数小，不用再开一条 SQL）。
- **预留 `totalCost` 扩展位**：shape 里不留字段，注释标注「成本计价砍到下轮（定价表易腐，20 §15.4 坑 2），要加时按 model 查定价表乘 totalTokens」。

### 2.3 入参校验

period 不在枚举内 → 400；`startDate>endDate` → 400；日期格式非 YYYY-MM-DD → 400。

## 3. 涉及文件

修改：

- `apps/server/src/db/repositories/usage-record-repository.ts` — 加 `sumByDateAndModel` + `UsageStatsRow`。
- `apps/server/src/routes/index.ts` — 注册 `registerUsageRoutes`（static 之前）。

新增：

- `apps/server/src/routes/usage.ts` — `GET /api/usage/stats`。
- `tests/usage-stats-route.test.ts` — 见 §4。

不动 settle/双写、不动单会话 usage 路由、不加定价表/缓存/迁移。

## 4. 步骤（测试先行）

1. **RED-1（repository 分组聚合）**：插几行不同 date/model 的 usage_records，断言 `sumByDateAndModel` 按 date+model 分组且五元组+cache_write 各自 SUM 正确；带 providerId 过滤只剩该 provider 的行。红。
2. **GREEN-1**：实现 §2.1，全绿。
3. **RED-2（路由）**：起 app，塞数据，`GET /api/usage/stats?period=day` 返回 rows+totals；`startDate/endDate` 覆盖 period；`providerId`/`modelId` 过滤生效；非法 period/range → 400。红。
4. **GREEN-2**：实现 §2.2/§2.3，全绿。
5. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | 多 date/model 数据 + `period=week` | rows 按 date+model 分组，五元组+cache_write SUM 正确，totals=Σrows |
| 2 | `startDate/endDate` | 覆盖 period，只返回范围内 |
| 3 | `providerId=anthropic` | 只返回 `model LIKE 'anthropic:%'` 的行 |
| 4 | `modelId=<裸 id>` / `<pid:mid>` | 裸 id 走后缀匹配，全限定走精确匹配 |
| 5 | 非法 period / `startDate>endDate` | 400 |
| 6 | 空库 | rows=[], totals 全 0，不报错 |

E2E：跑几轮对话（不同模型），`curl '/api/usage/stats?period=day'` 看到按模型分组的真实用量 + cache_write 非零（若触发 prompt cache）。

## 6. 坑

1. **provider 过滤走 `model` 冗余列 LIKE，别加 provider_id 列**。`model` 已是 `"providerId:modelId"`（T21 定的反范式口径，为免 JOIN）——为它再拆一列是过度规范化，AND LIKE 就够。
2. **UTC 一致**。`date` 列是 settle 时按 UTC 算的（`UsageRecordInsert.date` 注释），路由的 period→range 也必须用 UTC，别用本地时区——否则「今天」在两端对不上。
3. **不算 cost 但留口**。stats 的价值 80% 在 token 量，成本计价依赖易腐定价表，砍掉；但 rows/totals 的 shape 设计要让将来加 `totalCost` 不破 API。
4. **totals 应用层算，不再开 SQL**。rows 行数 = date×model，单机量级小，应用层 reduce 即可。
5. **不缓存**。Alma 带 TTL 缓存是因为它的库大；Eva 单机 SUM 几毫秒，缓存是过早优化（00 §3.5）。
