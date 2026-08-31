# 一次 Run 今天是怎么跑的

> **这是当前事实，不是目标。** 最后一次逐项对照代码：2026-08-31。
> 主链的五个阶段在 `apps/server/src/modules/runs/run-coordinator.ts` 的注释里标了 ①–⑤，
> 这篇是它的导读，不是它的副本 —— 有分歧以代码为准。

## 0. 五个文件读完一次对话

按真实调用顺序：

| # | 文件 | 它负责 |
|---|---|---|
| 1 | `modules/runs/route.ts` | 三条端点、SSE 连接、`RunOutcome` → 409/503/400、404 语义。**没有业务顺序** |
| 2 | `modules/runs/run-coordinator.ts` | 五个阶段的顺序 + 13 行流式循环 + 内联 `RunScope`。**只有顺序** |
| 3 | `modules/runs/run-runtime-builder.ts` | 「这轮 agent 能用什么」：skill / 记忆 / plan gate / MCP / plan weave / 子代理 / 观测 |
| 4 | `packages/harness/src/agents/agent.ts` | 工具管道 + `streamText` 主循环 |
| 5 | `modules/runs/run-finalizer.ts` | 终态的**唯一**出口 |

链上还有 `run-preparation` / `run-ledger` / `run-hub` / `assistant-message-recorder` /
`run-approval-channel`，但它们是被调用的能力，不是要按顺序读的编排。

## 1. 三条端点

```text
POST /api/v1/runs/stream          开一次新 Run(SSE)
GET  /api/v1/runs/:runId/stream   重新挂到在飞的 Run(刷新后续跟流)
POST /api/v1/runs/:runId/abort    真正停下来的唯一方式
```

- **断连不等于停止。** SSE 订阅者退场只是少了一个观众：run 继续跑，pending 审批继续等人。
- `GET .../stream` 返回 404 是正常语义 —— run 在刷新与这次请求之间跑完了，前端退回只读 DB 消息。
- 409 会带上 `activeRunId`，前端据此直接挂到在跑的那个 run 上，不用再查一次 status。

## 2. 五个阶段

```text
① 输入    会话互斥 → 落用户消息 → 绑 workspace → 定 modelId → 开台账行
② 装配    skill 选择 / 记忆 / plan gate / MCP / plan weave / 解析模型 → Agent
③ 上下文  compact、历史转 model messages、记忆召回(要 ② 给出的窗口信息)
④ 开流    SSE 头 → run_start 帧 → 子代理运行时(要有连接可推帧)
⑤ 流式    13 行 for-await:emit 给订阅者 + push 给消息投影 → finalizer.settle
```

四条**顺序不能换**的理由，换了会静默坏掉：

1. **`runLedger.start()` 在模型解析之前。** provider 配错、模型不可用时也要留下一行
   `failure_layer=routing` 的台账；挪到 Prepare 之后，routing 失败就变成查不到的 Run。
2. **「选定 `modelId`」属于 ①，「把 `modelId` 解析成 provider 绑定」属于 ②。**
   retry 的模型来源是 `body.modelId ?? sessions.model`，它依赖被重试消息所在的会话记录 ——
   一起搬进 ② 会让 retry 丢掉「沿用被重试那轮的模型」。
3. **工作区在 agent 之前。** agent 的工具集依赖工作区，工作区来自会话。
4. **子代理运行时在 `stream.open()` 之后。** 子代理的 SSE 帧要有连接可推。

还有一条容易被"整理"掉的：**请求体的 schema parse 在 coordinator，不在 route。**
`runRegistry.register(runId)` 发生在看 body 之前，所以校验失败也必须走同一套 `finally`
清理；提到 route 会留下一个没人 unregister 的 runId。

## 3. 终态只有一个出口

`RunFinalizer` 三条出口互斥：

| 出口 | 什么时候 | 台账 |
|---|---|---|
| `settle()` | 流式跑完（含 aborted / stream error —— 它们也算"跑完了"） | 终态 + usage |
| `fail()` | 流式**开始前**失败（装配、模型不可用、会话忙） | `failure_layer` = routing / context |
| `closeWithError()` | 已开始流式后失败，HTTP 头发不出去了 | 从 SSE 通道告知 |

`release()` 不是出口，是资源释放，三条路都走。

这条不变量由编译器守：coordinator 拿到的是 `RunOpeningLedger`（只有 `start` / `patchRouting`），
`settle` / `fail` 在 `RunSettlingLedger` 上，只有 finalizer 有。在 coordinator 里写
`runLedger.settle(...)` 编译不过。`lint:arch` 的 `run-ledger-terminal-state` 再兜一层。

## 4. 审批

审批的归属键是 **`runId`，不是 sessionId**（`ApprovalGateway.cancelByRun`）。
`RunRegistry` 因此刻意不持有 `sessionId` —— 一旦它知道会话，下一个人就会把它当归属源用，
两套取消语义会各长一半。

放行链的顺序也是产品语义，不能改：

```text
bash 只读直放 → plan 文件写入直放 → policy(always-allow)命中 → 才弹窗问人
```

`exit_plan_mode` 走的是**平行的 plan review 通道**（决策有 approve / revise / reject /
reject_and_exit / dismissed），不是普通工具的 boolean 审批，而且**永远不许有 always-allow key**。

## 5. 一次 Run 留下了什么

| 落点 | 内容 |
|---|---|
| `messages` | 用户消息 + assistant 消息（流式期间由 `AssistantMessageRecorder` 投影，终态落库） |
| `runs` | 台账行：requested/resolved 模型、capture level、终态、`failure_layer` |
| `run_events` | append-only 事实台账，`seq` 由 run-scoped recorder 独占单调分配 |
| `usage_records` | token 用量（独立存活，没有 runs 外键） |
| `approval_requests` | 审批请求与决策（含 plan review 的 JSON 决策） |

崩溃时未闭合的操作由启动清扫补 `operation_abandoned`；retention 按整 Run 粒度删。

## 6. 前端这一侧

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

## 7. 这条链的测试

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
