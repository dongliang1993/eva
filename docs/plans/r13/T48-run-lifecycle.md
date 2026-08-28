# T48 · Run 父子关系、生命周期与保留

> 前置：T47（abandoned 事件要写 ledger）。读 `00-overview.md` §3 契约 2、3、9。
> 方案出处：设计文档 §3.1、§3.3、§4.1、§7.1。

## 1. 问题

三个缺口：

1. **失败在 Run 之前**。`runLedger.start` 现在在 `prepareRunContext` 之后调用（`routes/runs.ts:286-288`）。Provider 配错、模型解析失败、Skill 选择炸了 —— 这些 Run 一行记录都不留，正好是最需要事后查的那类失败。
2. **后台子代理没有身份**。`subagent-runner.ts:119` 是 `void spawn()` 后立刻返回 taskId，父 Run 正常结束时 `routes/runs.ts:422` 就 unregister 了，而正常结束**不触发** AbortSignal，所以子代理还在跑。它没有自己的 `runs` 行，事件无处可去；写进父 Run 等于在已 settle 的 Run 上继续追加。
3. **崩溃后的未闭合操作**。`deps.ts:83-97` 已有三条 `failStale` 先例，但它们只收口 Run/任务/审批行，不会给 ledger 里那些「有 started 没 completed」的操作留任何痕迹。

## 2. 改动

### 2.1 `runs` 表调整

`schema.ts:178-203` 增列（全部可空，老行不回填）：

| 字段 | 说明 |
|---|---|
| `parent_run_id` | 后台子代理来源 Run；`NULL` 即主 Run |
| `background_task_id` | 对应 `background_tasks.id`，可空 |
| `requested_model` | 路由前请求的模型 |
| `failure_layer` | `routing/model/tool/context/orchestration/unknown`；aborted 仍由 `status` 表达，不进这个枚举 |
| `capture_level` | `off/redacted/full`，记录这条 Run 当时的抓取级别 |

`started_at/ended_at` 保持 ISO text，不做全库时间迁移。

**不加 `runs.agent`**：`parent_run_id IS NULL` 就是主/子的判别；子代理类型走 `background_task_id → background_tasks.subagent_type`（`schema.ts:155`），发起它的 Tool Call 走同一行的 `parent_tool_call_id`。前台子代理不建独立 Run，它的 taskId 只出现在 `run_events.agent` —— 但同样能用 `agent → background_tasks.id` 反查类型，因为 `taskStore.create` 在 background 分支之前就跑了（`subagent-runner.ts:103-110`）。

### 2.2 Run 提前创建 + routing patch

- `StartRunOptions.model` 改可选。
- `run-ledger.ts` 增 `patchRouting(runId, requestedModel, resolvedModel)`。
- `routes/runs.ts`：Session 与 `userMessageId` 一确定就 `runLedger.start`（挪到 `prepareRunInput` 之后、`selectRunSkills` 之前），模型解析成功后 `patchRouting`。解析失败走 `settle(runId, { status: "error", failureLayer: "routing" })`。
- `DrizzleRunRepository.settle`（`run-repository.ts:80`）注意：它内部会写 `usage_records`，且 `:107` 在 run 行不存在时抛错。提前创建之后这条路径更早可达，别让「没有 usage 的早期失败」在这里炸 —— usage 缺失是正常的。

### 2.3 后台子代理独立 Run

`subagent-runner.ts` 的 background 分支：`taskStore.create` 之后、`void spawn()` 之前，为子代理建一条 `runs` 行（`parent_run_id` = 当前 Run，`background_task_id` = taskId），并为它建独立 recorder（seq 从 0）。settle 独立进行，与父 Run 无关。

**父 Run settle 后不许再追加父 ledger**：recorder 按 Run 绑定，子代理拿的是自己那个，天然做不到 —— 这条靠结构保证，不靠运行时检查。

多层递归以后开放时沿 `parent_run_id` 递归，本卡只做一层（`canSpawnAtDepth(0)` 现在也只允许一层，`subagent-runner.ts:96`）。

### 2.4 启动清扫序列

扩 `deps.ts:83-97`，顺序固定：

1. `failStale()` / `failStaleTasks()` / `failStalePending()` —— 保持现状。
2. **新增**：对上一步收成 error 的每条 Run，扫它的 ledger，为未配对的 `*_started` 追加 `operation_abandoned`（带 `severity=error`、payload 记 orphan kind）。历史事实不改写，只追加。
3. **新增**：retention —— 按 `retentionDays` 删过期 Run；库超 `maxDatabaseBytes` 时从最老的 completed Run 开始删。后台子 Run 与父 Run 按 `parent_run_id` 一起清理，不能只删父的。`usage_records` 的保留策略独立，不跟着删。

retention 必须整 Run 粒度删。**不许删「活 Run 里的旧事件」** —— `request_snapshot_ref` 的引用链在 Run 内，删中间事件会打断它（设计文档 §4.3）。

## 3. 验收

- 故意配错 provider 发一次 run：`runs` 里有行、`status=error`、`failure_layer=routing`、`requested_model` 有值而 `model` 为空。
- 模型解析成功的正常 run：`requested_model` 与 `model` 都有值，`patchRouting` 只写一次。
- 后台子代理：`runs` 里有独立行、`parent_run_id` 指向父、`background_task_id` 对得上 `background_tasks.id`；父 Run 已 `completed` 之后子代理仍能往**自己**的 Run 追加事件，父 Run 的 `max(seq)` 不再变化。
- 通过 `background_task_id` 能查出 `subagent_type` 与 `parent_tool_call_id`；前台子代理用 `run_events.agent` 也能查出同样两项。
- 杀进程重启：在飞 Run 变 `error`，它 ledger 里未闭合的 `tool_call_started` / `model_call_started` 各多出一条 `operation_abandoned`，已配对的事件一条不动。
- `retentionDays=0` 跑一次清扫：过期 Run 及其子 Run 的 `run_events` 全清、外键不留孤儿、`usage_records` 不受影响。
- 库体积超限时从最老 completed Run 开始删，running Run 不被删。

## 4. 实施备注

- migration 0030 手写（0029 同因：drizzle snapshot 断档）。`parent_run_id` 是**自引用 FK cascade** —— 「子 Run 与父 Run 一起清理」结构保证，不靠应用层自觉。
- **0030 重建了 `usage_records` 去掉 runs FK**（保留 sessions FK）：留着它 retention 删 Run 会把聚合台账级联清空，验收「usage_records 不受影响」和「外键不留孤儿」无法同时成立。关联语义不变（`run_id` 值还在），只是生命周期解耦。
- 503 回滚（`AgentUnavailableError` + 本次请求新建会话）仍按原产品决策删会话，routing 失败的台账行随之级联消失；failure_layer=routing 的留痕针对**已有会话**。测试钉的是后者。
- `failStale()` 返回值从 count 改成 run id 列表（启动清扫要接着补 abandoned）；`listBySession` 的「主 Run」过滤在本卡补上（`runs.parent_run_id IS NULL` 的 EXISTS，不影响 session_time 索引）。
- recorder 的 seq 初始化改为**读现有 maxSeq 续接**（创建时一次索引读）：新 Run 从 0 开始不变；启动清扫给 stale Run 补事件时续在已有之后，不撞 UNIQUE。
- 容量档用 in-use 字节 `(page_count - freelist_count) * page_size` 做闸门 —— freelist 不归零文件，拿文件大小当闸门会被自己的删除骗成死循环。
- 后台子代理的独立 recorder 绑定（`toObserver(childRecorder, {agent})`）在 T49 随 observer 参数一起进 `buildSubagent`，本卡只建行与 settle。
