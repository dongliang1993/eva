# T52 · 轨迹与导出 API

> 前置：T47（repository）、T48（Run 父子关系）。可与 T49–T51 并行。读 `00-overview.md` §3 契约 9、10。
> 方案出处：设计文档 §9.1、§9.4、§11。

## 1. 问题

会话级和单 Run 级是两种游标语义，很容易被合并成一个然后两边都错。

`seq` 是 Run 级的（`UNIQUE(run_id, seq)`）。一个 Session 里先后多条主 Run 的 seq 都从 0 重新开始，**区间重叠**，所以 `beforeSeq=1925` 在会话视图里既不能定序也不能翻页。

## 2. 改动

### 2.1 三个接口

```text
GET /api/v1/threads/:sessionId/trajectory?beforeOccurredAtMs=&beforeRunId=&beforeSeq=&limit=
GET /api/v1/threads/:sessionId/session-log
GET /api/v1/runs/:runId/trajectory?beforeSeq=&limit=
```

会话接口响应两部分：

- `events` —— **只有主 Run**（`parent_run_id IS NULL`）的事件页，按 `(occurred_at_ms, run_id, seq)` 倒序。
- `subRuns` —— 该 Session 全部后台子 Run 的摘要数组（Run id、`parent_tool_call_id`、`subagent_type`、status、事件数、时间范围），**不分页**，来自 `runs` + `background_tasks`。

子 Run 的事件不进 `events`；前端展开某个 Tool 行时用 `GET /runs/:runId/trajectory` 单独拉。原因见设计文档 §9.1：锚点 `tool_call_started` 必然比子 Run 的每条事件都旧，而游标是 `before*`（新在前、上滚取更旧），平铺流第一页就会拿到一批无处可挂的孤儿，缓冲上限还不可预估 —— 长跑子代理能压出任意多条，且它的锚点可能落在更早的另一条主 Run 里。

### 2.2 游标

会话级用三元组 `(occurred_at_ms, run_id, seq)`：`occurred_at_ms` 定序，后两项只做同毫秒内的稳定 tiebreaker。行值比较走 `sql` 模板（drizzle 无行值构造器），索引由 `idx_run_events_session_time` 支撑。

单 Run 级继续用 `seq` —— 单 Run 内严格递增且唯一。**两个接口的游标语义不合并**，也不要为了「统一」给单 Run 接口加时间游标。

### 2.3 session log 导出

`GET /threads/:sessionId/session-log` 返回 JSONL：首行 Session header，后续每条带 `run_id + seq`，按 `(occurred_at_ms, run_id, seq)` 稳定排序。后台子 Run **包含在导出里**（导出不是分页视图，没有孤儿问题）。

**不声称全会话 seq 连续** —— 只保证单 Run 内连续。直接读持久层，不从 UI 反向拼装（对齐 DSH 的 `session-export.ts`）。同步写没有待 flush 队列，只需确保当前事务已结束。

### 2.4 token 白名单

`app.ts:35-52` 的 loopback token 白名单放行三种：`url === "/v1/health"`、`GET` 且 `url === "/api/v1/threads"`、GET/HEAD 且 `!url.startsWith("/api/")`。**轨迹与导出接口不进白名单** —— 它们返回 system prompt、工具入参与输出，比聊天列表敏感得多。

好消息是这三条判定用的是精确相等，`/api/v1/threads/:sessionId/trajectory` 天然落不进去，本卡不需要改 `app.ts`。要守的是**反向**：以后谁想把那条 threads 白名单改成前缀匹配，就会顺手放行轨迹接口。给它加一条测试钉住（无 token 访问轨迹接口必须 401）。浏览器端继续走 `withLoopbackToken()`（`apps/web/src/shared/api/auth.ts:32`）。

### 2.5 脱敏边界

所有裁剪与脱敏在服务端完成（T47 §2.4 已在写入时做过一轮）；**客户端查询参数不能提升 capture level**，接口不接受任何 `captureContent` 之类的入参。

## 3. 验收

- 一个 Session 里跑三条主 Run，每条 300 条事件：翻页取完 900 条，无重复、无丢失、顺序与直接按三元组排序的结果逐条相同。
- 人为让两条不同 Run 的事件落在同一毫秒：翻页边界不重复也不跳过。
- `subRuns` 在带 `beforeOccurredAtMs` 时返回内容不变（不受分页影响）。
- 后台子代理的事件不出现在 `events` 里；用它的 runId 调单 Run 接口能拿到全部事件。
- 单 Run 接口用 `beforeSeq` 翻页正确；给它传 `beforeOccurredAtMs` 被忽略或 400，不静默半支持。
- session-log 的 JSONL 行数 = 该 Session 所有 Run（含子 Run）事件总数 + 1；排序稳定，两次导出 byte 相同。
- 启用 loopback token 后无 token 访问三个接口全部 401；`GET /api/v1/threads` 仍然放行。
