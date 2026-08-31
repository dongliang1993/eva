# r13 · S27 Agent 轨迹 ledger（第一阶段）与会话内轨迹页

> 切片编号 **S27**，来源 `docs/plans/2026-08-26-agent-observability-design.md`（已过三轮评审，第三轮修订点见该文 §6.1、§9.1、§11）。
> 前置阅读：设计文档全文（尤其 §3 并发模型、§4 数据模型、§6.1 唯一碰产品行为的改动、§9.1 子 Run 为什么不参与会话分页）；`../r12/00-overview.md` 的任务卡格式。
> DSH 证据：`.refrences/deepseek-harness`，`packages/core/session/**`（append-only ledger + 连续 seq）、`packages/client/ui-trajectory/**`（投影、三泳道、检查器）。

## 1. 目标

把「这个 Run 到底发生了什么」变成可查事实，而不是靠 Pino 日志和聊天流反推：

1. **canonical ledger（T47–T48）**：新增 `run_events` 一张 append-only 表，`runs` 补齐父子关系与失败归因。第一阶段不建任何查询投影表。
2. **事件与计时（T49–T51）**：observer 从进程级单例改成 run-scoped，工具耗时拆成审批等待 / 排队等待 / 真实执行三段，并把含义模糊的 `durationMs` 从产品链路上换掉。
3. **读取面（T52）**：会话级与单 Run 级两个轨迹接口 + session log 导出。
4. **轨迹页（T53–T54）**：DSH 风格的会话内「对话 / 轨迹」切换，纯前端投影。

## 2. 现状盘点（代码实证）

| 能力 | 现状 | 位置 |
|---|---|---|
| observer 装配 | ⚠️ 进程级单例，无 run 维度；主/子代理共用同一个 | `apps/server/src/deps.ts:34`、`agent-factory.ts:375`/`:459` |
| telemetry 事件 | ⚠️ 8 类事件，既无 runId 也无 agent 判别 | `packages/harness/src/agents/observer.ts:37` |
| 事件出口 | ⚠️ 只进 Pino，不落库 | `apps/server/src/observability.ts` |
| 工具耗时 | ⚠️ 从 `tool-call` 到 `tool-result` 全链计时，含审批等待与排队等待 | `stream-part-mapper.ts:74`、`:40-41` |
| 包装链 | ✅ 装配 `cap → approval → planGate`，执行反序 | `packages/harness/src/agents/agent.ts:697-708` |
| 三段打点位 | ✅ 三个 wrapper 都在，但都不上报时间 | `with-approval.ts:48`、`concurrency-cap.ts:63`、`build-tool.ts:99-100` |
| abort 补发 | ✅ 靠 `clock` 枚举在飞工具补取消 result（T26） | `agent.ts:519-553` |
| `runs` 表 | ⚠️ 无父子关系、无 `failure_layer`、无 `requested_model`；时间是 ISO text | `apps/server/src/db/schema.ts:178-203` |
| Run 创建时机 | ⚠️ `runLedger.start` 在 `prepareRunContext` 之后 —— 路由/模型解析失败没有 Run 行 | `routes/runs.ts:286-288`、`services/runs/run-ledger.ts:26` |
| 跨会话并发 | ✅ 只挡同会话；测试已钉住「别的会话在跑不该挡新会话」 | `run-preparation.ts:115`、`tests/run-concurrency.test.ts:145` |
| 后台子代理 | ⚠️ `void spawn()` 立即返回，可越过父 Run 存活；只有 `background_tasks` 行，没有自己的 Run | `subagent-runner.ts:119`、`schema.ts:147-172` |
| 前台子代理 | ✅ 同样有 `background_tasks` 行（`taskStore.create` 在 background 分支之前） | `subagent-runner.ts:103-110` |
| 启动清扫先例 | ✅ 三条 `failStale`：runs / tasks / pending 审批 | `deps.ts:83-97` |
| `durationMs` 产品链 | ⚠️ 已渲染成工具卡徽章，并落进 `messages.message` JSON | `stream-events.ts:70` → `ui-message-builder.ts:175` → `run-stream-client.ts:91` → `tool-call-block.tsx:101` |
| 虚拟化 | ✅ `@tanstack/react-virtual` 已在消息列表用 | `apps/web/src/features/threads/components/message-list.tsx:2,31` |
| SDK 内建 telemetry | ❌ 自有源码零命中 `experimental_telemetry`，不依赖它 | — |

**结论：不需要重做 observer 抽象，也不需要动跨会话并发。T47 先把表和 recorder 立起来；T48 补 Run 的父子与生命周期；T49 才把 observer 换成 run-scoped。T51 是整个切片里唯一改动用户可见行为的卡，独立成卡就是为了能单独回滚。**

## 3. 执行契约

1. **ledger 是唯一执行事实源，但不是唯一表**。`messages` 继续管聊天历史与版本树，`usage_records` 继续管聚合。第一阶段不建 model/tool 查询表；任何投影必须满足「删掉能从 ledger 完整重建」。
2. **事件 append-only，start/completed 配对，不 UPDATE 旧行**。崩溃后的收口靠启动清扫追加 abandoned 事件，不靠回写。
3. **没有隐式 current run**。observer 必须显式绑定 `{runId, agent}`；`agent: "main" | taskId` 单独不足以定位事件归属（设计文档 §3.2）。禁止在 `run-registry` 或任何单例里放「当前 run」。
4. **seq 由 Run 级 recorder 单调分配**，同一 Run 内主 Agent 与多个前台子代理共用一个计数器；分配与 insert 在同一同步临界段内完成。后台子代理有自己的 Run 和 recorder，seq 从 0 重新开始。
5. **写入同步，不建队列**。insert 包在 try/catch 里，失败只写 Pino，绝不抛回 Agent loop。要不要批处理由 T47 的基准数据决定，不能先按假设加队列。
6. **`clock` 只删字段不删 map**。`agent.ts:519-553` 的 abort 补发依赖它枚举在飞集合，删了会让工具卡永远停在 running（T26 修过的 bug）。
7. **abort 不伪造分段时间**。补发事件是 `tool_call_abandoned`，只带未分解的 `waited_ms`；不填 `tool_exec_ms` / `waiting_for_approval_ms` / `waiting_in_queue_ms`。
8. **脱敏在持久化和导出前执行，客户端参数不能提升 capture level**。脱敏器自身异常时丢弃整个字段，不许回退保存原文。
9. **子 Run 事件不参与会话分页**。会话流只有主 Run 事件，后台子 Run 是折叠行、展开时单独拉（设计文档 §9.1）。理由是锚点必然更旧，平铺 + `before*` 游标会产生上限不可预估的孤儿。
10. **轨迹/导出接口不进 loopback token 白名单**。它们返回 system prompt 与工具入参输出，比聊天接口更敏感。

## 4. 任务卡

| 卡 | 文件 | 一句话 | 估时 | 依赖 |
|---|---|---|---|---|
| **T47** | `T47-run-events-ledger.md` | `run_events` 表 + repository + run-scoped recorder（seq 分配、canonical JSON、hash、脱敏、截断、同步写）+ 写入基准 | 1.5–2 天 | 无 |
| **T48** | `T48-run-lifecycle.md` | `runs` 补 `parent_run_id/background_task_id/requested_model/failure_layer/capture_level`；Run 提前创建 + `patchRouting`；后台子代理独立 Run；启动清扫追加 abandoned + retention | 1.5–2 天 | T47 |
| **T49** | `T49-run-scoped-observer.md` | observer 事件扩容 + `agent` 字段；`AgentBuildOptions` 收 run-scoped observer；agent.ts 补 Turn/Step/Model/first-token/终态事件 | 2 天 | T47、T48 |
| **T50** | `T50-tool-timing.md` | 三个 wrapper 各自上报审批等待/排队等待/真实执行，汇入 run-scoped timing state | 1–1.5 天 | T49 |
| **T51** | `T51-duration-migration.md` | SSE 帧换 `toolExecMs/approvalWaitMs/queueWaitMs`；UIMessage + 徽章 + 实时/重放两条读路径；abort 改发 `tool_call_abandoned` | 1–1.5 天 | T50 |
| **T52** | `T52-trajectory-api.md` | 会话级复合游标接口（`events` + `subRuns`）、单 Run 接口、session log 导出 | 1–1.5 天 | T47、T48 |
| **T53** | `T53-trajectory-page.md` | 「对话 / 轨迹」切换、`deriveTrajectory` 纯投影、虚拟化台账、折叠与分页 | 2 天 | T52 |
| **T54** | `T54-trajectory-inspector.md` | 三泳道 Overview、类型化右侧检查器、父子跳转、session log 下载 | 1.5–2 天 | T53 |

**顺序**：T47 → T48 → T49 → T50 → T51 串行（每一卡都吃前一卡的产物）。T52 只依赖 T47/T48，可与 T49–T51 并行。T53/T54 是前端，等 T52 接口定稿后开工。

**分期**：T47–T52 是设计文档的第一阶段，全绿即「事实齐全但还没有 UI」。T53/T54 对应 §9，落地后 S27 才算完整。设计文档 §10 的 feedback/eval/版本比较/Replay 明确不在本切片，`artifact_versions` 也不在。

## 5. 与 S26 的接触面

`plan_gate` / `plan_weave` 的工具调用会照常进 ledger，不需要特殊处理 —— 它们只是普通工具。唯一要注意的是 `withPlanGate` 现在包在最外层（`agent.ts:707`），被闸门挡掉的调用**不进审批也不进 execute**，所以它的事件只有 `tool_call_started` + `tool_call_completed(status=error)`，三段时间全为 0。T50 不要把「三段都是 0」当异常处理。

## 6. 验收总表

| 卡 | 一句话验收 |
|---|---|
| T47 | 同一 Run 内主 Agent 与两个前台子代理并发发事件时 `UNIQUE(run_id, seq)` 始终成立、无乱序覆盖；insert 抛错时 Agent 继续跑、错误只进 Pino；`SECRET-TOKEN-123`、Bearer token 和 API key 不出现在库里；基准报告给出 metadata-only 与最大 payload 的 p50/p95/p99 |
| T48 | Provider/模型/Skill 解析失败也有 Run 行且 `failure_layer=routing`；后台子代理有自己的 Run，父 Run settle 后父 ledger 不再被追加；崩溃重启后 stale Run 变 error 且未闭合操作出现 abandoned 事件；30 天与 1 GiB retention 都能删到最老记录、外键不留孤儿 |
| T49 | 不同 Session 的 Run 并行时事件准确落各自 runId；前台子代理事件写父 Run 且带 taskId；一次含并行工具调用的 Run 能只从 `run_events` 投影出 Turn/Step/Request/Assistant/Tool 行 |
| T50 | 审批等待 40 万 ms、执行 51 ms 的那种调用被拆成两个独立数字；无审批无排队时对应字段为 0；被 plan gate 挡掉的调用三段全 0 且不报异常 |
| T51 | 工具卡把等待与执行分开显示、不相加；只有旧 `toolMetadata.durationMs` 的历史消息隐藏徽章（不按消息时间戳猜版本）；abort 后卡片立即离开 running 态且落库 part 不悬挂 |
| T52 | 会话接口用 `(occurred_at_ms, run_id, seq)` 三元组稳定翻页，同一 Session 内先后多条主 Run 的 seq 重叠也不错序；`subRuns` 摘要不受 `before*` 影响；无 token 访问轨迹/导出返回 401 |
| T53 | 500 条展示记录时 DOM 行数有界；prepend 旧页后可见行与选中态不跳；锚点还没翻到的后台子 Run 先不显示且不报错 |
| T54 | 三泳道能定位到最慢的那次工具调用；检查器显示调用当时的 snapshot 而不是当前定义；session log 下载的 JSONL 按 `(occurred_at_ms, run_id, seq)` 稳定排序 |

S27 切片全绿 = T47–T54 全绿 + `pnpm typecheck && pnpm test` 全绿。
