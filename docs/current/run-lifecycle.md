# 一次 Run 今天是怎么跑的

> **这是当前事实，不是目标。** 最后一次逐项对照代码：2026-10-12。
> 五个阶段在 `apps/server/src/modules/runs/run-coordinator.ts` 的 `Coordinator.run` 里按顺序写着，
> 这篇是它的导读，不是它的副本 —— 有分歧以代码为准。

## 0. 三个概念

```text
Thread  持久的对话：消息树 + 选定的模型 + 绑定的工作区
Run     一条用户消息触发的一次执行，由 Coordinator 编排
Options 每轮按 (Thread, 模型) 装出来的 query() 输入，用完即弃
```

**Options 不跨 Run 存活。** 它知道的一切都在这一轮开始时从数据库读出来，所以切换模型、
改设置、换工作区不需要任何失效逻辑 —— 下一轮自然拿到新值。`LanguageModel` 实例按
provider 配置缓存（`agent-factory.ts`），这是唯一跨 Run 的东西。

## 1. 四个文件读完一次对话

| # | 文件 | 它负责 |
|---|---|---|
| 1 | `modules/runs/route.ts` | 三条端点、`RunOutcome` → 409/503/400、404 语义。**没有业务顺序** |
| 2 | `modules/runs/run-coordinator.ts` | `Coordinator.run`：五个阶段的顺序 + 收尾。**只有顺序** |
| 3 | `modules/runs/run-runtime-builder.ts` | 「这一轮 agent 有什么」：MCP / 记忆 / plan gate / 子代理 / 模型 → `assemble()` |
| 4 | `packages/harness/src/query/query.ts` + `agents/run-loop.ts` | `query()` 入口 + turn 循环本体（`HarnessMessage` 流） |

被调用的能力（不必按顺序读）：`run-preparation`（输入、工作区、历史）、`agent-factory`
（模型解析与 prompt → Options）、`assistant-message-recorder`（消息投影与检查点）、
`run-hub`（订阅者扇出）、`run-permissions`（canUseTool 放行链）、
`run-trajectory`（HarnessMessage → run_events）、`harness-frames`（HarnessMessage → SSE 帧）。

## 2. 三条端点

```text
POST /api/v1/runs/stream          开一次新 Run(SSE)
GET  /api/v1/runs/:runId/stream   重新挂到在飞的 Run(刷新后续跟流)
POST /api/v1/runs/:runId/abort    真正停下来的唯一方式
```

- **断连不等于停止。** SSE 订阅者退场只是少了一个观众：run 继续跑，pending 审批继续等人。
- `GET .../stream` 返回 404 是正常语义 —— run 在刷新与这次请求之间跑完了，前端退回只读 DB 消息。
- 409 会带上 `activeRunId`，前端据此直接挂到在跑的那个 run 上，不用再查一次 status。
- 带同一个 `requestId` 重发请求返回 409 + 已有 run 的身份，不会重复写消息。

## 3. 五个阶段

```text
   解析请求 → requestId 去重 → 注册 runId(abort 与重连靠它)
① 接收    同一事务：会话互斥 → 落用户消息 → 开台账行            (同步，第一次 await 之前)
② 装配    工作区 → MCP / 记忆 / plan gate / 子代理 / 模型 → Options 失败层 routing
③ 上下文  本轮分支可见的历史 → 模型消息                          失败层 context
④ 开流    SSE 头 → run_start 帧
⑤ 流式    for await (message of query())：子代理消息 → SubagentProjection；
          主 agent：trajectory/pino 吃消息，toRunStreamFrames(message) → recorder + emit
   收尾    同一事务：最终 assistant 消息 + 终态 + 记忆提取入队
```

三条**顺序不能换**的理由，换了会静默坏掉：

1. **台账（①）早于模型解析（②）。** provider 配错、模型不可用时也要留下一行
   `failure_layer=routing` 的台账；挪到装配之后，routing 失败就变成查不到的 Run。
2. **「选定 `modelId`」属于 ①，「解析成 provider 绑定」属于 ②。** retry 的模型来源是
   `body.modelId ?? sessions.model`，它依赖被重试消息所在的会话记录。
3. **工作区在 agent 之前。** agent 的工具集依赖工作区，工作区来自会话。

子代理在 ② 里只是 `options.agents` 里的定义，没有副作用。harness 的 `subagent` 工具在 ⑤ 里被调用时
才跑子代理，它的消息并在同一条 `query()` 流里（`task_started` … `task_notification`，中间的消息带
`parent_tool_use_id`）；⑤ 按 `parent_tool_use_id` 分两路：主 agent → recorder 帧 / 轨迹 / SSE，
子代理 → `SubagentProjection`（任务行、子代理消息、`subagent_update`、agent=taskId 的轨迹）。
run 结束时没收到 `task_notification` 的任务收成 failed。

## 4. 失败与收尾

失败层由**哪个阶段抛错**决定（`inStage(progress, layer, …)`），不靠在 catch 里反推。
收尾只看 `RunProgress` 记下的进度：

| 进度 | 收尾方式 |
|---|---|
| 没有 sessionId（解析、会话忙、retry 校验失败） | 不写台账，返回 `rejected` |
| 有 sessionId、还没开始录制（② / ③ 失败） | 终态记 `failure_layer`，返回 `rejected` → 503/400 |
| 已开始录制（⑤ 中失败或正常结束） | 终态以 assistant 消息为准；流已开，错误经 SSE 告知 |

三条路都走同一个 `settle()`：最终消息、`runs` 终态、记忆提取入队在**同一个事务**里。
「终态只写一次」由 `runs.settle` 的条件更新保证（只改 `status = 'running'` 的行）。
`finally` 里统一 `cancelByRun` + `unregister`。

检查点（流式期间落库 assistant 消息）由 `AssistantMessageRecorder.record` 自己决定：
工具调用、工具结果、新的一步立即落；其余至少每秒落一次。

## 5. 审批

审批的归属键是 **`runId`，不是 sessionId**（`ApprovalGateway.cancelByRun`）。
`RunRegistry` 因此刻意不持有 `sessionId` —— 一旦它知道会话，下一个人就会把它当归属源用，
两套取消语义会各长一半。

放行链的顺序也是产品语义，不能改：

```text
bash 只读直放 → plan 文件写入直放 → policy(always-allow)命中 → 才弹窗问人
```

`exit_plan_mode` 走的是**平行的 plan review 通道**（决策有 approve / revise / reject /
reject_and_exit / dismissed），不是普通工具的 boolean 审批，而且**永远不许有 always-allow key**。

## 6. 一次 Run 留下了什么

| 落点 | 内容 |
|---|---|
| `messages` | 用户消息 + assistant 消息（流式期间由 `AssistantMessageRecorder` 投影，终态落库） |
| `runs` | 台账行：requested/resolved 模型、capture level、终态、`failure_layer` |
| `run_events` | append-only 事实台账，`seq` 由 run-scoped recorder 独占单调分配 |
| `usage_records` | token 用量（独立存活，没有 runs 外键） |
| `approval_requests` | 审批请求与决策（含 plan review 的 JSON 决策） |

崩溃时未闭合的操作由启动清扫补 `operation_abandoned`；retention 按整 Run 粒度删。

## 7. 前端这一侧

```text
POST /runs/stream ──SSE──▶ run-stream-client(只解析协议)
                              │
                              ▼
                      use-run-controller ── dispatch ──▶ stream-reducer(纯函数)
                                                            │
                                                            ▼
                                                    use-chat 持有的唯一投影
```

- `run_start` 帧带回 `sessionId`（第一次对话时前端还没有它）。
- 刷新后 `loadSession` 会先拉历史，再问一次「这个会话有没有在飞的 run」，有就 attach。
- 流式期间只有 `streaming` 一个字段在变，`committed` 的引用不动 —— 见
  [`architecture.md` §4](./architecture.md) 的三条性能结论。

## 8. 这条链的测试

| 路径 | 测试 |
|---|---|
| send / 正常收尾 | `tests/server/runs/run-lifecycle.test.ts` |
| retry（同槽位落新版本） | `tests/server/runs/regenerate.test.ts` |
| abort / 断连不终止 / 重连重放 | `tests/server/runs/run-detach.test.ts` |
| 审批 pending 与 abort 取消 | `tests/server/approvals/approval-abort.test.ts` |
| 模型不可用 503 与会话回滚 | `tests/server/runs/run-lifecycle.test.ts` |
| 会话互斥 409 | `tests/server/runs/run-concurrency.test.ts` |
| 前端投影（事件序列） | `tests/web/streaming/stream-reducer.test.ts` |

这些是重构的安全网，**不许为了适配新结构而改断言**。
