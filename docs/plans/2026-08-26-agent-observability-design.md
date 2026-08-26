# Agent 轨迹与可观测性设计

> 状态：待评审。本文只定义方案，不包含实现。参考 DeepSeek Harness `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` 和 `.refrences/session.jsonl`。

## 1. 结论

Eva 的第一版不需要一套 Langfuse 式追踪平台。先做一条 append-only 执行日志，再从日志投影出 DSH 风格的会话内轨迹页。

第一阶段只新增一张表：

| 表 | 作用 |
|---|---|
| `run_events` | append-only canonical ledger，保存一次执行中可重建的事实 |

现有 `runs`、`messages`、`usage_records`、`background_tasks` 继续保留。`runs` 是执行根记录，`messages` 是聊天读模型，`usage_records` 服务 SQL 聚合，`background_tasks` 服务后台任务生命周期。第一阶段不新增 `model_calls`、`tool_calls`、`feedback`、`eval_results` 等查询表。Model Call、Tool Call、审批和压缩都从 ledger 投影；反馈和评测推迟到第二阶段。

结构事件和脱敏正文全量记录，不做 head sampling、tail promotion 或内存等待提升。写入使用 better-sqlite3 同步单行 insert，不增加队列、批量 flush 或 `trace_status=partial`。

## 2. Trace、Span、Event

- **Trace**：一次独立 Agent 执行。主 Agent 的一个 Run 是一条 Trace；能活过父 Run 的后台子代理拥有自己的 Run。
- **Span**：从 ledger 中配对出来的持续操作。`model_call_started/completed`、`tool_call_started/completed` 和 `approval_asked/decided` 分别形成 Model、Tool 和 Approval Span。
- **Event**：append-only ledger 中的一条事实。Event 是持久化单位，Span 是读取时投影，不另建 Span 表。

```text
runs
└── run_events, seq 0..N
    ├── turn_started
    ├── step_started
    ├── request_snapshot
    ├── model_call_started
    ├── assistant_message
    ├── tool_call_started
    ├── approval_asked
    ├── approval_decided
    ├── tool_call_completed
    ├── step_completed
    └── turn_completed
```

`run_id` 就是内部 Trace ID，不额外增加一套 `trace_id/span_id`。OpenTelemetry 导出适配器未来可以为每个 Run 生成 OTel Trace ID，并以 `(run_id, step_index, attempt)` 和 `(run_id, tool_call_id)` 生成稳定 Span。内部数据库不为尚未实现的导出协议提前承担 ID 体系。

## 3. 并发模型

### 3.1 保留跨会话并发 Run

不为 recorder 增加全局单 Run 闸。当前 `run-concurrency.test.ts` 明确约定“别的会话在跑不该挡住新会话”，全局互斥会把一个观测实现细节变成产品能力回退。即使加了全局闸，上一轮遗留后台子代理仍可能与下一轮主 Agent 同时发事件，所谓“当前 Run”依旧不是可靠归属键。

每个 Agent 实例必须拿到 run-scoped observer。主 Agent build 时绑定 `{ runId, agent: "main" }`；子代理 build 时绑定 `{ runId, agent: taskId }`。`AgentBuildOptions` 增加 observer context 或完整 observer 是合理的显式依赖，runId 已经存在于 `runs.ts` 和 `SubagentRunnerOptions`，不需要从模型层反向猜测。

### 3.2 observer 必须区分 Agent

主 Agent 和子代理目前都使用 `infra.observer`。不同会话主 Run、同一 Run 的多个子代理、旧后台任务与新 Run 都可能同时发事件。每条 Harness telemetry 增加：

```ts
agent: "main" | taskId
```

主 Agent 固定为 `main`。子代理创建时将 `taskId` 绑定到 observer wrapper。observer 本身同时闭包捕获 runId，事件里的 `agent` 只负责区分同一 Run 内的来源，不承担 Run 路由。这样没有全局 current-run 状态，也不需要维护容易泄漏的 `taskId → runId` 单例 Map。

### 3.3 后台子代理不能继续写已结束父 Run

`subagent-runner.ts` 的 background 分支用 `void spawn()`，父 Run 正常结束时不会 abort 它；`runs.ts` 随后会 `RunRegistry.unregister(runId)`。因此后台子代理可能活过父 Run。

规则如下：

- 前台子代理 `run_in_background=false`：完成后父 Agent 才继续，可以写父 `run_id`，用 `agent=taskId` 区分来源。
- 后台子代理 `run_in_background=true`：创建独立 `runs` 行，新增 `parent_run_id` 和 `background_task_id`；独立 settle，不能在父 Run 完成后继续追加父 ledger。发起它的 Tool Call 通过 `background_tasks.parent_tool_call_id` 查询。

后台子代理的内部 Run 不注册进主聊天的 `RunRegistry`，由 `background_tasks` 和它自己的 `runs` 行管理生命周期。

## 4. 数据模型

### 4.1 `runs` 调整

保留现有主键和状态。调整字段：

| 字段 | 说明 |
|---|---|
| `id` | 内部 Trace 标识 |
| `session_id` | 所属会话 |
| `parent_run_id` | 后台子代理来源 Run，可空 |
| `background_task_id` | 后台子代理对应的 `background_tasks.id`，可空 |
| `status` | `running/completed/aborted/error` |
| `requested_model` | 路由前请求模型，可空 |
| `model` | 解析后的实际模型，可空 |
| `failure_layer` | `routing/model/tool/context/orchestration/unknown`，aborted 仍由 status 表达 |
| `capture_level` | `off/redacted/full` |
| `user_message_id/assistant_message_id` | 输入输出锚点 |
| `finish_reason/usage/error` | 现有终态字段 |
| `started_at/ended_at` | 保持现有 ISO text，不做全库时间迁移 |

`parent_run_id IS NULL` 表示主 Run，非空表示后台子代理 Run。后台子代理类型通过 `background_task_id → background_tasks.subagent_type` 得出，不在 `runs` 冗余。发起它的 Tool Call 也通过同一任务行的 `parent_tool_call_id` 得出。前台子代理不建独立 Run，其 taskId 只记录在父 Run 的 `run_events.agent`。

`StartRunOptions.model` 改为可选，增加 `patchRouting(runId, requestedModel, resolvedModel)`。Run 在 Session 和 userMessageId 确定后立即创建，模型解析成功后补实际模型。这样 Provider、模型和 Skill 选择失败也有 Run 记录。

### 4.2 `run_events`

```text
id                TEXT PRIMARY KEY
run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE
session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
seq               INTEGER NOT NULL
agent             TEXT NOT NULL                 # main | taskId
kind              TEXT NOT NULL
turn_index        INTEGER
step_index        INTEGER
attempt           INTEGER
tool_call_id      TEXT
parent_tool_call_id TEXT
severity          TEXT NOT NULL                  # info | warn | error
payload           TEXT NOT NULL                  # redacted, capped JSON
occurred_at_ms    INTEGER NOT NULL                # epoch ms
duration_ms       INTEGER
UNIQUE(run_id, seq)
INDEX(run_id, turn_index, step_index)
INDEX(run_id, tool_call_id)
INDEX(run_id, occurred_at_ms)
INDEX(session_id, occurred_at_ms, run_id, seq)
```

所有新轨迹时间使用 epoch ms。现有 `runs/messages/usage_records` 的 ISO text 不迁移，两种格式通过 `run_id` 关联，不做跨表时间运算。

建议的第一版事件：

```text
run_started / routing_resolved / skills_selected / request_snapshot
turn_started / turn_completed
step_started / step_completed
model_call_started / model_first_token / model_call_completed / model_call_failed
assistant_message
tool_call_started / tool_call_completed
approval_asked / approval_decided
tool_call_repaired
context_compacted / context_overflow
loop_transition
run_completed / run_failed
```

事件使用 start/completed 配对，不更新旧行。进程崩溃后，启动清理先把 stale Run 收成 error，再为未配对的 started 事件追加 `operation_abandoned`。历史事实不改写。

同一个 Run 可能同时收到主 Agent 和多个前台子代理的事件，因此 `seq` 不能由各 Agent 自己计数。Server 为每个 run-scoped recorder 持有唯一的单调计数器；所有绑定到该 Run 的 observer wrapper 共享它。better-sqlite3 在同一 Node 线程同步写入，分配 seq 和 insert 在一个同步临界段内完成。后台子代理使用自己的 Run 和 recorder，seq 从 0 重新开始。

### 4.3 Request snapshot

DSH 只在 request header 初次出现、恢复或发生变化时记录完整快照，不会机械地在每个 Step 重复相同 Prompt。Eva 第一阶段沿用这个办法：`request_snapshot` 直接保存脱敏、限长后的 system prompt、Tool schemas、Skill manifest、provider/model 和调用设置，并携带各部分内容 hash。同一 Run 内若新 snapshot 的各部分 hash 与此前任一 snapshot 完全相同，则不重复写正文，只记录 `request_snapshot_ref` 指向那条事件，不要求两个 seq 相邻。

`request_snapshot_ref` 只能指向相同 `run_id` 的更早 seq，删除 Run 时引用双方一起级联清理，不形成跨 Run 链。第一阶段不建 `artifact_versions`。当版本比较和 Replay 在第二阶段真正消费不可变快照时，再把已有 request snapshot 去重迁移到内容寻址表。Tool 详情始终读取调用当时的 snapshot，不能读取当前定义。

## 5. 写入策略

### 5.1 同步追加，不建队列

Eva 使用 better-sqlite3，数据库已启用 WAL、`synchronous=NORMAL` 和 5 秒 busy timeout。轨迹事件发生时直接 insert：

```text
observer → redact/cap → INSERT run_events → return
```

每次 insert 包在 try/catch 中，失败只写 Pino，不抛回 Agent loop。没有内存队列，就没有 flush 超时、退出时丢队列或 partial 状态协调。

单行事务不保证永远是几十微秒，自动 checkpoint、磁盘压力和大 payload 都可能造成偶发延迟。因此第一版要加一个基准测试：分别测 metadata-only 和最大允许 payload 的 p50/p95/p99；只有数据证明同步写影响流式体验时，再引入批处理。不能先为假设中的性能问题增加队列。

### 5.2 canonical ledger 与现有表

`run_events` 是执行事实源。`messages` 继续承担聊天历史和版本树，`usage_records` 继续承担按日和模型聚合。它们是已经存在、访问模式不同的读模型，不在这次迁移中重写。

第一阶段不创建 model/tool 查询表。单 Run 轨迹按 `run_id, seq` 读取 ledger；会话轨迹则查询该 Session 的主 Run 与后台子 Run，按 `(occurred_at_ms, run_id, seq)` 合并，再由前端投影。以后出现“跨一万条 Run 查最慢工具”这类真实需求，再加可 drop、可从 ledger 重建的 projection 表或 materialized cache。

判断 projection 不是第二事实源的标准是：删除后能从 ledger 完整重建，写入失败不会改变 Run 的业务语义。

## 6. 时间打点

现有 `stream-part-mapper` 从收到 `tool-call` 到 `tool-result` 算 `durationMs`（`stream-part-mapper.ts:74` 落 `startedAt`，`:40-44` 算差），整条包装链 `planGate → withApproval → withConcurrencyCap → execute` 都夹在这两点之间，所以它包含审批等待和并发队列等待。第一阶段停止生成这个含义模糊的字段，但保留旧类型的可选读取能力，让历史 UIMessage 仍能解析。

注意删的是**字段**，不是那张 in-flight map。`clock` 有两份工作，第二份还在服役 —— 见 §6.1。

三段时间分别记录：

| 指标 | 开始与结束位置 |
|---|---|
| `waiting_for_approval_ms` | `withApproval` 调用 `requestApproval` 前后 |
| `waiting_in_queue_ms` | `withConcurrencyCap` 调用 `limiter.acquire()` 前后 |
| `tool_exec_ms` | 最内层业务 `definition.execute()` 前后 |

最内层执行时间在 `buildTool` 和 `buildJsonSchemaTool` 统一打点，不能由每个 Tool 自己实现。三层 wrapper 都要接受同一个 run-scoped telemetry sink 或通过 `ToolExecutionOptions` 上报。无审批、无排队时相应字段为 0；取消和异常也要发 completed/failed 事件。

模型时间分为：

- `model_total_ms`：`onStepStart` 到 `onStepEnd` 或 error。
- `model_ttft_ms`：`onStepStart` 到该 Step 第一条 text/reasoning/tool-call delta。
- `model_decoding_ms`：第一条 token 到 Step 结束。
- `orchestration_gap_ms`：上一步结束到下一步开始。

用户提供的 DSH 日志中，Turn 4 Step 2 的审批等待约 402,926 ms，获批后的 Tool 执行约 51 ms；Step 2 结束到 Step 3 开始约 31 ms。这三段必须分开显示。

### 6.1 删掉 `durationMs` 的两处连带影响

这是第一阶段唯一会碰到产品行为的改动，两件事必须一起做，否则会静默退化。

**(1) `clock` 不能整个删 —— T26 的 abort 补发依赖它。**

`agent.ts:519-540` 在 abort 时遍历 `clock` 的残留条目（已发 `tool-call`、未收 `tool-result` 的在飞集合），逐个补一条取消 result。原注释说明了理由：不补的话「UI 卡片永远停在 running、落库 part 悬挂 input-available」。

所以 `clock` 有两份工作：算 duration，和跟踪在飞集合。**保留这张 map 与 `startedAt`，只停止用它产出对外 `durationMs`**。最小实现不让 map 追踪 wrapper phase，因此 abort 补发 `tool_call_abandoned`（status=error），只带 `waited_ms = now - startedAt` 这段未分解的墙钟时间；不伪造 `tool_exec_ms`、`waiting_for_approval_ms` 或 `waiting_in_queue_ms`。

**(2) `durationMs` 是产品 UI 上显示的字段，不是内部指标。**

现有链路：mapper → SSE `tool-result.durationMs`（`stream-events.ts:70`）→ `ui-message-builder.ts:175-176` 包成 `toolMetadata.durationMs` → **写进 `messages.message` 的 UIMessage JSON**（`ui-message.ts:17`）→ `tool-call-block.tsx:101-104` 与 `:302-305` 渲染成工具卡上的耗时徽章。`replay-events.ts:54` 也在读它。

因此：

- SSE 的 `tool-result` 帧新增 `toolExecMs`、`approvalWaitMs`、`queueWaitMs`，过渡期保留旧 `durationMs?` 类型但新事件不再赋值。三个 wrapper 以 `toolCallId` 汇入同一份 run-scoped timing state，mapper 收到 result 时取走完整快照并写入 SSE；ledger 中相应的阶段事件仍各自独立。`ui-message-builder` 把新字段写入 `toolMetadata`，徽章才不会消失。
- 审批或排队非零时，工具卡应把等待与执行**分开呈现**，不要相加成一个数。轨迹页 §9.2 已经这么拆，聊天流里的卡片没有理由继续合并。
- `toolMetadata.durationMs` **已经落在历史消息的 JSON 里**。老消息带含等待的旧值，新消息带 `toolExecMs`。工具卡只在 `toolMetadata.toolExecMs` 存在时显示新徽章；只有旧 `durationMs` 时隐藏，不按消息时间戳猜版本。`replay-events.ts` 对旧值不再回灌成新字段。
- 这次迁移只处理 Tool Call 时间。`message-bubble.tsx` 的 `ThinkingBadge` 也叫 `durationMs`，但它表示 reasoning 时间，不在本次范围内。

## 7. 内容安全与保留

### 7.1 不采样

本地单用户应用先全量保留经过脱敏和上限控制的正文。采样会让普通慢任务缺少上下文，还需要把所有正文暂存在内存等待 tail promotion，复杂度和收益不匹配。

只保留四个设置：

```text
observability.enabled = true
observability.captureContent = redacted   # off | redacted | full
observability.retentionDays = 30
observability.maxDatabaseBytes = 1073741824
```

按天清理超过 retention 的旧 ledger；超过容量高水位时从最老的 completed Run 开始删除，后台子代理和父 Run 按引用一起清理。`usage_records` 的长期聚合保留策略独立。

### 7.2 最小脱敏底线

持久化和导出前递归处理：

- 键名匹配 `authorization/apiKey/token/password/secret/cookie/set-cookie/privateKey` 时替换值。
- 字符串识别 `Bearer ` 和常见 `sk-` key。
- 单字段超过 16 KiB 时截断，并保存 hash、原始字节数和 `truncated=true`。
- `full` 只表示完整业务正文，凭据规则始终生效。
- 脱敏器异常时丢弃整个字段，不能回退保存原文。

PEM、JWT、银行卡、邮箱、手机号、bash heredoc 解析和 MCP per-tool allowlist 暂不进入第一版。发现真实泄漏样本后再增加规则。

## 8. 失败归因

| `failure_layer` | 判定 |
|---|---|
| `routing` | 第一个 Model Call 前，Provider、模型、Skill 选择或工具暴露失败 |
| `model` | Model Call 失败，且不是 context overflow |
| `tool` | Tool Call 失败，或审批拒绝后任务失败 |
| `context` | compact、token budget、context overflow、历史转换失败 |
| `orchestration` | max steps、状态机、消息落库、子代理通知或 ledger invariant 失败 |
| `unknown` | 证据不足 |

Run 的 `aborted` 状态已经表达取消，不在 failure_layer 重复一遍。UI 同时展示 first failing event、last successful stage、error type 和 retry count，不能只显示推断标签。

## 9. DSH 风格会话内轨迹页

入口放在会话标题下的「对话 / 轨迹」Tab，不先做独立全局 Observability 页面。

```text
┌ 会话标题                              Session log ┐
│ 对话 | 轨迹                                      │
├ Duration · Turns · Calls · Search               ┤
├ Input / Model / Tools 三泳道 Overview             ┤
├ 事件台账                              ┬ 详情检查器 ┤
│ Turn / Step / 角色 / 摘要              │ Tabs       │
└───────────────────────────────────────┴────────────┘
```

### 9.1 前端投影

会话接口只返回该 Session **主 Run**（`parent_run_id IS NULL`）的事件页，按 `(occurred_at_ms, run_id, seq)` 排序；后台子 Run 的事件不在这个流里，每个子 Run 只带一行摘要，展开对应 Tool 行时再单独拉取。增加 `deriveTrajectory(runEvents)`，输出：

```text
system | user | context | assistant | tool | subtool | compacted | approval | error
```

它把 request snapshot 投影成 System 和 Request 边界，把 model start/message/end 合成 Assistant，把 tool start/end 合成 Tool，把 Approval Event 显示为 Tool 的等待阶段。`parent_run_id` 非空的后台子 Run 通过 `background_task_id → parent_tool_call_id` 嵌套到发起它的 Tool 行下，不与父 Run 事件同层混排；前台子代理已经在父 ledger 内，用 `agent=taskId` 区分。展示行不落库。子代理以后支持多层递归时，沿 `parent_run_id` 递归构树。

**子 Run 事件为什么不参与会话分页。**嵌套需要锚点，而锚点 `tool_call_started` 一定比子 Run 的每一条事件都旧 —— 子代理是被那次 Tool Call 派出去的。§11 的游标是 `before*`：最新在前、上滚取更旧的页。所以平铺流的第一页会先拿到一批子 Run 事件，它们的锚行要到后面某一页才出现，这期间投影手里是一堆无处可挂的孤儿。前端缓冲孤儿等锚点的上限也无法预估：一个长跑后台子代理能压出任意多条事件，而 §3.3 还允许它的锚点落在**更早的另一条主 Run** 里。

所以选另一边：会话流里只有主 Run 事件，子 Run 是折叠行。摘要行来自 `runs WHERE session_id = ? AND parent_run_id IS NOT NULL`，与 ledger 分页无关、不受 `before*` 影响，按 `parent_tool_call_id` 建索引 —— 渲染到哪一行就挂哪一行，锚点还没翻到的子 Run 先不显示。这样投影任何时刻都不持有悬空事件，会话游标也只需要在主 Run 事件上定序。

### 9.2 Overview 和台账

- 三泳道为 Input、Model、Tools。
- 支持等宽顺序、真实 duration、压缩 idle 和完整 wall-clock。
- Assistant 内拆 TTFT 与 decoding；Tool 内拆 approval wait、queue wait 和 execution。
- Turn 用粗分隔线，Step 用窄标记，Request 用边界点。
- Duration、Turns、Calls、搜索四项放在固定工具栏。
- 双击 Turn 折叠整轮，双击 Assistant 折叠其 Tool Calls。
- 长轨迹从尾部打开，向上分页。prepend 后保持语义 row key、选中态和可见位置。
- 直接使用现有 `@tanstack/react-virtual@^3.14.9`，不再选型。

### 9.3 右侧检查器

| 记录 | 标签 |
|---|---|
| Tool | Summary / Payload / Result / Schema / Timing |
| Assistant | Summary / Preview / Raw / Source |
| Request | Summary / Options / Usage / Timing |
| User / Context | Summary / Preview / Raw / Source |
| System | System Prompt / Tools / Diff |
| Compaction | Summary / Raw Output |

Summary 显示 Hierarchy、Status、Provider/Model、Error 和有限预览。Tool 可以跳到父 Assistant/Request，Assistant 的 tool-call block 可以跳到 Tool。脱敏字段带显式标记，避免用户误以为工具实际收到 `[REDACTED]`。

### 9.4 Session log 导出

第一版提供当前会话 JSONL 下载。因为 ledger 的 seq 是 Run 级，Session 导出不能声称全会话 seq 连续：首行是 Session header，后续记录带 `run_id + seq`，并按 `(occurred_at_ms, run_id, seq)` 排序。导出直接读取持久层，不从 UI 反向拼装。同步 insert 没有待 flush 队列，因此只需要确保当前数据库事务结束。以后增加媒体时再升级为 ZIP；后台子 Run 已包含在会话导出中。

Trace 和 export API 返回 system prompt、工具参数和输出，不能加入 `app.ts` 的 loopback token 白名单。浏览器端继续走 `withLoopbackToken()`。

## 10. 第二阶段：反馈、评测、版本比较与 Replay

第二阶段再增加：

- `feedback` 和 `eval_results` 表。它们是事后标注，不属于 append-only 执行事实。
- `artifact_versions` 内容寻址表，以及保留标签、比较组和实验元数据。
- Re-run 和 Simulation Replay。
- 全局 Run 搜索、跨版本比较和聚合分析。

Replay 总是生成新 Run。来源关系在第二阶段增加 `replay_of_run_id` 和 `comparison_group_id`，不回填第一阶段的历史 Run。没有固定 seed、模型 revision 和外部状态快照时，UI 明示 best-effort。

## 11. API 草案

第一阶段：

```text
GET /api/v1/threads/:sessionId/trajectory?beforeOccurredAtMs=&beforeRunId=&beforeSeq=&limit=
GET /api/v1/threads/:sessionId/session-log
GET /api/v1/runs/:runId/trajectory
```

会话轨迹响应分两部分：`events` 是主 Run 事件页（`parent_run_id IS NULL`），`subRuns` 是该 Session 全部后台子 Run 的摘要数组（Run id、`parent_tool_call_id`、状态、事件数、时间范围），不分页。子 Run 的事件不进 `events`，前端展开 Tool 行时用 `GET /runs/:runId/trajectory` 拉 —— 理由见 §9.1。

会话级游标不能只用 `seq`。`seq` 是 Run 级（`UNIQUE(run_id, seq)`），而一个 Session 里先后多条主 Run 的 seq 都从 0 重新开始，**区间重叠**；§3.3 的后台子 Run 更是各自计数（虽然它们已经不进 `events`）。所以 `beforeSeq=1925` 在会话视图里既不能定序也不能翻页。游标是三元组 `(occurred_at_ms, run_id, seq)`：`occurred_at_ms` 定序，后两项只做同毫秒内的稳定 tiebreaker；UUIDv4 的字典序没有业务含义，但足够稳定。会话读取由 `INDEX(session_id, occurred_at_ms, run_id, seq)` 支撑。`INDEX(run_id, occurred_at_ms)` 服务单 Run 时间范围查询；单 Run 的 seq 翻页仍优先使用 `UNIQUE(run_id, seq)`。

`GET /runs/:runId/trajectory` 是单 Run 视图，它可以继续用 `seq` 翻页 —— 单 Run 内 seq 严格递增且唯一。两个接口的游标语义不同，不要合并成一个。

第二阶段：

```text
GET  /api/v1/runs?cursor=&status=&model=&failureLayer=&sessionId=
GET  /api/v1/runs/:runId/compare/:otherRunId
POST /api/v1/runs/:runId/replay
POST /api/v1/runs/:runId/feedback
GET  /api/v1/runs/:runId/evals
POST /api/v1/runs/:runId/evals
```

所有内容裁剪和脱敏由服务端执行，客户端查询参数不能提升 capture level。

## 12. 实施顺序

### 第一阶段

1. 调整 `RunLedger.start`，让 Run 在模型解析前创建；增加 routing patch。
2. 新增 `run_events` 和 repository，时间统一用 epoch ms。
3. 让 `AgentFactory.build/buildSubagent` 接受 run-scoped observer，显式绑定 runId 和 agent。
4. 实现 canonical JSON、hash、最小脱敏和截断。
5. 给 telemetry 增加 `agent`，后台子代理创建独立 Run。
6. 调整 Tool wrapper 打点，删除 mapper 的含糊 `durationMs`。
7. 补齐 Turn、Step、Request、Model、Tool、Approval、Context 和终态事件。
8. 增加轨迹分页和 Session log 导出 API。
9. 扩展 `deps.ts` 启动清理序列：stale Run 收口后，为未配对操作追加 abandoned Event，并执行 retention。

### 第二阶段

1. 在 `features/threads/` 增加「对话 / 轨迹」切换和独立 `trajectory/` 子模块。
2. 做三泳道 Overview、虚拟化台账、Turn/Call 折叠和搜索。
3. 做类型化右侧检查器、父子跳转和 Session log 下载。
4. 加 Prompt/上下文、Token、审批等待、延迟和错误定位。
5. 加 Feedback、Eval、版本比较和 Replay。

## 13. 验收标准

- 不同 Session 的前台 Run 可以并行，所有事件仍准确写入各自 runId。
- 前台子代理 Event 写父 Run 且带 taskId；后台子代理拥有自己的 Run，并且父 Run settle 后不再被追加。
- 同一 Run 内主 Agent 和多个前台子代理并发发事件时，`UNIQUE(run_id, seq)` 始终成立且没有乱序覆盖。
- 一次含并行 Tool Call 的 Run 可以只从 `run_events` 投影出 Turn、Step、Request、Assistant 和 Tool 行。
- Tool Timing 分开显示 approval wait、queue wait 和 execution；不存在含义模糊的 `durationMs`。
- Abort 时 ToolCallClock 仍能枚举全部在飞调用；取消行不伪造分段执行时间，旧消息的 duration 徽章保持隐藏。
- 默认设置下，`SECRET-TOKEN-123`、Bearer token 和 API key 不出现在数据库、API 或导出文件中。
- 轨迹 insert 抛错时 Agent 继续运行，错误只进入 Pino。
- 崩溃后 stale Run 变为 error，未闭合操作出现 abandoned Event。
- 30 天和 1 GiB retention 都能删除最老记录，外键级联不留孤儿。
- 单 Run 内 seq 连续；Session log 导出按 `(occurred_at_ms, run_id, seq)` 稳定排序，轨迹投影和在线流对同一事实生成相同 record identity。
- 500 条展示记录时 DOM 行数有界；prepend 旧页后可见行和选中态不跳。
- Trace/export API 在启用 loopback token 时，无 token 返回 401。

## 14. 代码落点

- `packages/harness/src/agents/observer.ts`：增加 `agent` 与事件字段。
- `packages/harness/src/agents/agent.ts`：Turn/Step/Model/first-token/retry/终态事件。
- `packages/harness/src/tools/with-approval.ts`：审批等待。
- `packages/harness/src/tools/concurrency-cap.ts`：队列等待。
- `packages/harness/src/tools/build-tool.ts`、`build-json-schema-tool.ts`：真实执行时间。
- `packages/harness/src/agents/stream-part-mapper.ts`：保留 ToolCallClock 供 abort 枚举，停止输出旧 duration。
- `apps/server/src/services/run-registry.ts`：保持按 runId 管理并发主 Run，不增加全局 current-run 状态。
- `apps/server/src/services/agent-factory.ts`：主/子 Agent 的 run-scoped observer wrapper。
- `apps/server/src/services/subagents/subagent-runner.ts`：后台子代理独立 Run。
- `apps/server/src/services/runs/run-ledger.ts`：提前 start、routing patch、独立子 Run settle。
- `apps/server/src/db/schema.ts` 与 migration：Run 父子关系和 ledger。
- `apps/server/src/deps.ts`：observer 装配、stale/abandoned/retention 清理。
- `apps/server/src/routes/runs.ts`：Run 创建时机、轨迹读取与导出入口。
- `apps/server/src/app.ts`：确认 trace/export API 不进入 token 白名单。
- `packages/shared/src/stream-events.ts`：`tool-result` 帧新增 `toolExecMs/approvalWaitMs/queueWaitMs`。
- `packages/shared/src/ui-message-builder.ts`、`ui-message.ts`：新字段写入 `toolMetadata`，徽章才不会消失。
- `packages/shared/src/replay-events.ts`：重载路径读新字段，旧 `durationMs` 不回灌。
- `apps/web/src/shared/api/run-stream-client.ts`：实时路径读新字段（`:91` 现在读的是 `toolMetadata.durationMs`）。
- `apps/web/src/features/threads/components/tool-call-block.tsx`：等待与执行分开呈现；只有旧 `durationMs` 时隐藏徽章。
- `apps/web/src/features/threads/chat-page.tsx`：会话视图切换。
- `apps/web/src/features/threads/trajectory/`：纯 projection、Overview、台账和检查器。

## 15. 参考依据

- DeepSeek Harness `packages/core/session`：append-only Session Event、连续 seq 和 request header。
- DeepSeek Harness `packages/client/ui-trajectory`：事件投影、三泳道时间线、详情检查器、折叠、分页和虚拟化。
- DeepSeek Harness `packages/host/apiproxy/src/session-export.ts`：直接导出持久层 artifact。
- 用户提供的 `.refrences/session.jsonl`：审批等待、Tool 执行和 orchestration gap 的毫秒级实测。
- SQLite WAL 文档与 better-sqlite3 性能说明：单写者、快速 append、自动 checkpoint 和偶发慢 commit 的边界。
- OpenTelemetry Trace API：Trace、Span、Event、Link 的概念与未来导出映射。
