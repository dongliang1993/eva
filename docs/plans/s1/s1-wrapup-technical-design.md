# S1 收尾 · SSE 协议对齐 + Abort 链路 技术方案

> 状态：待评审。评审通过后按 §8 任务拆分实施。
> 依据：`docs/architecture/14` §6（流式协议）、`docs/architecture/15` §2（S1 收尾范围）、`docs/architecture/04` §1.4（直转 SDK chunk）。
> 范围一句话：把 `POST /api/v1/runs/stream` 的 SSE 事件从自定义协议切换到 AI SDK chunk 命名 + 合流纪律，并补齐 run 级 abort 链路。

---

## 1. 背景与范围

### 1.1 已完成（不在本方案）

- harness LangChain → Vercel AI SDK 迁移：`streamText` + `stopWhen: stepCountIs(1)` 手写外层 loop，proactive/reactive compact、tool-result budget、max-output 续写、observer 遥测全部保留（`lead-agent.ts`）。
- 前端流式基础设施雏形：`shared/streaming/delta-accumulator.ts`（seq 重组）、`use-smooth-stream.ts`（rAF 字符泵）已存在。

### 1.2 本方案范围（In Scope）

| # | 工作项 | 侧 |
|---|---|---|
| A | SSE 事件契约切换到 AI SDK chunk 命名（`text-delta` / `tool-call` / `tool-result` / `step-start` / `finish` / `error`）+ Eva 自有域隔离 | shared + harness + server + web |
| B | text-delta coalesce（100ms 窗口，首 delta 立即发） | harness |
| C | `finish` settle 帧带全量 text + usage + finishReason（收敛点） | harness + server |
| D | run 级 abort：`AbortController` 注册表 + `POST /runs/:runId/abort` + SSE 断连触发 + abort 部分结果落库 | server + harness + web |
| E | 前端事件分发改名适配 + **DeltaAccumulator 实例化 bug 修复** | web |
| F | 实测常量集中（`constants.ts`）+ 回归测试 | harness |

### 1.3 明确不做（Out of Scope，属 S1.1 / S4）

- ❌ 前端三红线完整重写：useSmoothStream 接入 use-chat、Streamdown 分块 memo、消息列表虚拟化、pages→features 目录重构 → **S1.1**。
- ❌ 审批流改造（InteractionBroker 语义、cancelAll、requires_action 派生态）→ **S4**。本方案不动现有 approval 轮询机制。
- ❌ partial-json 工具入参流式解析的增长门槛/stall 逃生 → 随 S1.1 前端渲染一起做；本方案只做服务端**透传** `tool-input-*` 事件（见 §3.3 D2）。
- ❌ UIMessage 整存 / 版本树 / Session-Run 领域模型 → **S2**。

---

## 2. 现状实证（改造点锚定）

| 位置 | 现状 | 问题 |
|---|---|---|
| `harness/agents/types.ts:30-46` | `AgentStreamEvent` = `text_chunk / tool_call_start / tool_call_end / result / error` | 自定义协议，与 AI SDK chunk 不对齐 |
| `harness/agents/lead-agent.ts:389-540` | 消费 `result.stream`，映射 `text-delta→text_chunk`、`tool-call→tool_call_start`、`tool-result→tool_call_end` | `tool-input-start/delta/end`、`reasoning-delta` 被 default 分支丢弃；每个 text-delta 立即 yield（无 coalesce） |
| `lead-agent.ts:630` | `runSingleStep(..., undefined, ...)` | **abortSignal 被硬编码 undefined**，abort 链路断头 |
| `lead-agent.ts:604-740` | runLoop 每 step 跑 `streamText` | 无 `step-start` 事件发给客户端（observer 有，SSE 无） |
| `server/routes/runs.ts:145-214` | SSE 帧 `event: <type>\ndata: {...event, seq}`；`end`/`error` 帧不带 seq | 事件名自定义；无 abort 端点；连接断开不终止 agent（白跑 token） |
| `server/services/runs.ts` | `RunApiService.stream` 直通 `agent.stream` | 无 run 注册/注销 |
| `web/api/client.ts:141` | `const accumulator = new DeltaAccumulator()` **在 `while(read)` 循环内** | **bug**：每次 TCP chunk 重建 accumulator，跨 chunk 的 pending 乱序事件被丢弃，seq 重组实际失效 |
| `web/api/client.ts:76-97` | dispatchEvent switch 旧事件名 | 需随协议改名 |

---

## 3. 目标设计

### 3.1 SSE 帧格式

所有帧统一 `{ seq, type, ...payload }`，**包括终态帧**（end/error 也带 seq，前端可断言无缺口）：

```
event: <type>\n
data: {"seq": 42, "type": "<type>", ...}\n\n
```

- `seq`：单 run 内从 1 单调递增，由服务端路由统一编号（harness 事件不自带 seq，路由层补）。
- `event:` 字段与 `data.type` 同值（SSE 标准 event 字段用于客户端分流，data 内 type 用于 accumulator 分发）。

### 3.2 事件契约（放 `packages/shared/src/stream-events.ts`，server/web 共用）

**AI SDK 域**（命名与 `ai@7` UIMessageChunk 对齐，kebab-case）：

| event | payload | 产生时机 |
|---|---|---|
| `text-delta` | `{ textDelta: string }` | 正文增量（coalesce 后批量，见 §3.3） |
| `reasoning-delta` | `{ textDelta: string }` | 思考增量（透传，模型不出则没有） |
| `tool-input-start` | `{ toolCallId, toolName }` | 工具入参开始流式 |
| `tool-input-delta` | `{ toolCallId, delta: string }` | 工具入参增量（透传） |
| `tool-call` | `{ toolCallId, toolName, input }` | 入参完整、工具开始执行（≈旧 tool_call_start） |
| `tool-result` | `{ toolCallId, toolName, output, status, durationMs }` | 工具完成（≈旧 tool_call_end） |
| `step-start` | `{ step: number }` | 每个 agent step 开始（新事件，S4 步骤分组渲染的前置） |
| `finish` | `{ text, toolCalls, usage?, finishReason: "stop"\|"aborted"\|"error"\|"max-steps", durationMs }` | **settle 帧**：全量 text 为收敛点 |
| `error` | `{ message }` | 流级错误（终态） |

**Eva 自有域**（snake_case，与 SDK 命名空间视觉隔离）：

| event | payload | 产生时机 |
|---|---|---|
| `run_start` | `{ runId, sessionId }` | 流的第一帧，携带 abort 端点所需的 runId |
| `end` | `{ finishReason }` | 流的最后一帧（SSE 通道关闭信号，恒在 finish/error 之后） |

> 审批事件（`approval_request/resolved`）**本期不新增**：现有 approval 走 REST 轮询，S4 再评估迁移到 SSE push。

### 3.3 六个关键决策（评审重点）

**D1 · 命名对齐**：AI SDK 域事件名与 SDK chunk 类型逐字一致（`text-delta` 不是 `text_delta`），前端未来可直接换 `useChat` 语义；Eva 自有域 snake_case 一眼可辨。——依据 04 §1.4 "直转 SDK chunk，不造协议"。

**D2 · `tool-input-*` 只透传不解析**：服务端把 `tool-input-start/delta/end` 原样转发（前端 S1.1 才做 partial-json 增量渲染）。成本≈0，为 S1.1 留好数据通道。

**D3 · coalesce 在 harness 不在路由**：`LeadAgent.stream()` 产出事件后，经一个 `coalesceTextDeltas()` async-iterator 包装再 yield 出去。路由保持"无脑转发"。规则：
- 窗口 100ms：窗口内连续的 `text-delta` 合并成一帧（textDelta 拼接）；
- **首 delta 立即发**（上一个非 text-delta 事件后的第一个 text-delta 不等窗口，首 token 尽快上屏）；
- flush 时机：窗口到期 / 遇到非 text-delta 事件 / 流结束。
- `reasoning-delta` 与 `text-delta` 分开各自 coalesce，不混拼。

**D4 · abort 三级触发**：
1. **主动 abort**：`POST /api/v1/runs/:runId/abort` → 查 RunRegistry → `controller.abort()`；
2. **断连 abort**：`request.raw.on("close")` → abort（用户关页面/断网不白烧 token）；
3. **UI stop 按钮**：调 abort 端点 + 本地 `reader.cancel()`。
`runId` 由路由生成（nanoid），经 `run_start` 帧告知前端。

**D5 · abort 是"落库部分结果"，不是"丢弃"**：abortSignal 传到 `streamText` → SDK 抛 AbortError → lead-agent 捕获后：
- 已收集的 text/toolCalls 照常回灌 `state.messages`；
- yield `finish { finishReason: "aborted", text: <已产出部分> }`；
- 路由侧 `recordAssistantResult` 照常落库，metadata 标 `aborted: true`。
依据 14 §5.5/WeaveLynx：finalize 不是终点，部分产物是有效工作成果。

**D6 · 无向后兼容**：本地开发应用，前后端同 PR 切换，旧事件名直接删除，不留双协议。

---

## 4. 服务端改造（apps/server）

### 4.1 `services/run-registry.ts`（新增，~40 行）

```ts
export class RunRegistry {
  private readonly controllers = new Map<string, AbortController>();
  register(runId: string): AbortController { /* 建 controller 存表 */ }
  abort(runId: string): boolean { /* 找到则 abort，返回是否存在 */ }
  unregister(runId: string): void { /* 流结束/异常必清，防泄漏 */ }
}
```

- 挂在 `app.services`（services/index.ts 装配，单例）。
- **必须 try/finally unregister**：流正常结束、出错、abort 三条路径都要清表。

### 4.2 `routes/runs.ts` 改造

```
POST /api/v1/runs/stream:
  runId = nanoid()
  controller = services.runRegistry.register(runId)
  try:
    writeHead(SSE headers)
    write(run_start 帧 { seq:1, runId, sessionId })
    request.raw.on("close", () => services.runRegistry.abort(runId))
    for await (event of services.runs.stream({ ...input, abortSignal: controller.signal })):
      seq += 1; write({ ...event, seq })
    write(end 帧 { seq, finishReason })
  catch: 已发头则写 error 帧，未发头则 4xx/5xx
  finally: services.runRegistry.unregister(runId); reply.raw.end()

POST /api/v1/runs/:runId/abort:
  const found = services.runRegistry.abort(params.runId)
  return found ? { ok: true } : 404 { error: "run not found or already finished" }
```

- `recordAssistantResult` 调用不变，但 `finish.finishReason === "aborted"` 时 metadata 加 `aborted: true`。
- `thinkingDurationMs` 的判定从 `text_chunk` 改为监听首个 `text-delta`。

### 4.3 `services/runs.ts`

- `RunInput` / `toAgentRunInput` 增加可选 `abortSignal`，透传给 `agent.stream({...input, abortSignal })`。
- `types/runs.ts` 的 `runSchema` 不动（abortSignal 是服务端内部注入，不进请求体）。

---

## 5. Harness 改造（packages/harness）

### 5.1 `constants.ts`（新增）

```ts
export const STREAM_COALESCE_WINDOW_MS = 100;  // WeaveLynx 实测经验值：观感无感知的最大批量窗口
export const STREAM_FIRST_DELTA_IMMEDIATE = true; // 首 token 尽快上屏
```

> 后续 stall 500ms / late-arrival 5s / MAX_DEPTH 等陆续进此文件（14 原则 12），本方案先建文件。

### 5.2 `agents/types.ts`：事件类型重定义

```ts
export type AgentStreamEvent =
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning-delta"; textDelta: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: string; status: "success" | "error"; durationMs?: number }
  | { type: "step-start"; step: number }
  | { type: "finish"; text: string; toolCalls: AgentToolCallResult[]; finishReason: FinishReason; usage?: TokenUsage }
  | { type: "error"; message: string };
```

`AgentRunInput` 增加 `abortSignal?: AbortSignal`。

### 5.3 `agents/lead-agent.ts` 四点改动

1. **事件映射**（`runSingleStep` switch）：
   - `text-delta` → yield `{ type: "text-delta", textDelta: part.text }`（stream 模式）；
   - `reasoning-delta` → 透传（SDK part 同名）；
   - `tool-input-start/delta/end` → 透传（`tool-input-end` 可不转发，完整入参随 `tool-call` 到达）；
   - `tool-call` / `tool-result` / `tool-error` → 新事件名（payload 同现状）。
2. **`step-start`**：`runLoop` 每个 step 进入时（`llm_call_start` 旁）yield `{ type: "step-start", step }`。
3. **abortSignal 接通**：`AgentRunInput.abortSignal` → `stream()` → `runLoop(state, mode, signal)` → `runSingleStep(..., signal, ...)`（替换 :630 的 `undefined`）。abort 时 SDK 抛错 → 在 `runLoop` catch：
   - `isAbortError(error)` → 正常收尾：yield `finish { finishReason: "aborted", text: 已积累文本, toolCalls }`，**不 yield error**；
   - 其他错误 → 维持现有 reactive compact / yield error。
   - 注意：审批等待中（`requestApproval` await 时）收到 abort → 当前步结束后退出即可，S4 再做审批 cancelAll。
4. **finish 帧**：三处 `yield { type: "result" }`（空响应/正常结束/max-steps）改为 `finish`，带 `finishReason`（`stop` / `stop`+空响应标记 / `max-steps`）与累计 `usage`（`state.totalTokens`）、`durationMs`（run 起点计时）。

### 5.4 `agents/coalesce-stream.ts`（新增，~80 行）

```ts
export async function* coalesceTextDeltas(
  events: AsyncIterable<AgentStreamEvent>
): AsyncGenerator<AgentStreamEvent>
```

- 状态机：`pendingText / pendingReasoning` 两个 buffer + 各自 timer；
- 首个 delta（buffer 为空时到达）立即 yield，后续进 buffer；
- 窗口到期或遇到非 delta 事件时 flush（buffer 非空则先 yield 合并帧）；
- `LeadAgent.stream()` 改为 `yield* coalesceTextDeltas(this.runLoop(state, "stream"))`；
- wait 模式（invoke）不过 coalesce（无消费者收益）。

---

## 6. 前端适配（apps/web，最小改动）

### 6.1 `api/client.ts`

1. **修 accumulator bug**（:141）：`const accumulator = new DeltaAccumulator()` 移到 `while` 循环**外**（streamChat 函数顶部），整个流生命周期一个实例。
2. `dispatchEvent` 改新事件名：
   - `text-delta` → `onTextChunk(ev.textDelta)`（回调签名不变，use-chat 零改动）；
   - `tool-call` → `onToolCallStart({ toolName, toolCallId, args: ev.input })`（字段映射在这里做，use-chat 零改动）；
   - `tool-result` → `onToolCallEnd(...)`；
   - `finish` → `onResult(ev.text, ev.toolCalls, ev.finishReason)`；
   - `run_start` → 存 `runId`，供 stop 按钮调 abort；
   - `step-start` / `tool-input-*` / `reasoning-delta`：**本期 default 忽略**（S1.1 启用）。
3. 终态帧（end/error）也带 seq 后，保持"不进 accumulator 直接处理"的现状即可（它们在流尾，无乱序风险）。

### 6.2 `hooks/use-chat.ts`

- 仅：stop 按钮支持——`sendMessage` 返回/暴露 `stopStreaming()`：调 `POST /runs/:runId/abort` + 本地 reader cancel + `setIsStreaming(false)`。
- chat-input 加停止按钮（流式中 send 按钮变 stop 图标）。
- 其余渲染逻辑不动（全量 setState/全篇 markdown 留给 S1.1）。

---

## 7. 测试与验证计划

### 7.1 单元测试（tests/，Vitest）

| 用例 | 断言 |
|---|---|
| `coalesce-stream`：首 delta 立即发 | 第一个 text-delta 不等 100ms 窗口即产出 |
| `coalesce-stream`：窗口内合并 | 窗口内 5 个 text-delta → 1 帧，textDelta 拼接正确 |
| `coalesce-stream`：非 delta 事件触发 flush | buffer 未到期但遇到 tool-call → 先吐合并帧再透传 |
| `coalesce-stream`：text/reasoning 不混 | 两类 delta 各自合并，互不拼接 |
| `DeltaAccumulator`（回归） | 乱序/重复/跨多次 push 调用补齐（覆盖 client.ts bug 场景：模拟分两次 read 的事件流） |
| `RunRegistry` | register/abort/unregister 三路径；abort 不存在 runId 返回 false；finally 清表无泄漏 |
| lead-agent abort | mock model + abortSignal.abort() → 产出 `finish { finishReason: "aborted" }`，不产出 error |

### 7.2 手工验证（curl + UI）

```bash
# 1. 协议对齐：事件名与 AI SDK chunk 一致，所有帧带 seq 且单调
curl -N -X POST http://127.0.0.1:8082/api/v1/runs/stream \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"读一下 README 然后总结一下"}]}'
# 预期：run_start → step-start → text-delta*(coalesce 后批量) → tool-input-start →
#       tool-call → tool-result → step-start → ... → finish(全量 text) → end

# 2. 主动 abort：另开终端调 abort，curl 侧应立即收到 finish(aborted) + end
curl -X POST http://127.0.0.1:8082/api/v1/runs/<runId>/abort

# 3. 断连 abort：curl 跑到一半 Ctrl+C；服务端日志应显示 run 被 abort（不白跑）
```

UI 走查：
- [ ] 流式出字正常（coalesce 后无可见顿挫——100ms 窗口人类无感知）
- [ ] 工具调用卡片 start/end 正常展示
- [ ] 流式中点 stop → 生成停止，已产出文本保留，输入框恢复可用
- [ ] 生成中途刷新页面 → 服务端 run 被 abort（观察日志，不再空跑）

### 7.3 回归

- [ ] `pnpm typecheck` 绿
- [ ] `pnpm test` 绿（含新增用例）
- [ ] grep 确认无 `text_chunk / tool_call_start / tool_call_end` 残留（harness/server/web 三处）
- [ ] `/api/v1/runs/wait` 路径不受影响（invoke 不走 coalesce）

---

## 8. 任务拆分（按依赖序，估时 3–4 天）

| # | 任务 | 文件 | 依赖 |
|---|---|---|---|
| 1 | shared 事件契约类型 | `packages/shared/src/stream-events.ts` + 导出 | — |
| 2 | harness 常量 + 事件类型重定义 + RunInput.abortSignal | `harness/src/constants.ts`、`agents/types.ts` | 1 |
| 3 | lead-agent 四点改动（映射/step-start/abort/finish） | `agents/lead-agent.ts` | 2 |
| 4 | coalesce-stream + LeadAgent.stream 接入 | `agents/coalesce-stream.ts` | 3 |
| 5 | RunRegistry + services 装配 | `server/services/run-registry.ts`、`services/index.ts` | — |
| 6 | runs 路由改造（runId/注册/close 监听/帧格式/abort 端点） | `server/routes/runs.ts`、`services/runs.ts`、`types/runs.ts` | 1,4,5 |
| 7 | web client.ts（bug 修复 + 改名 + runId 留存） | `web/src/api/client.ts` | 1 |
| 8 | use-chat stop 按钮 + chat-input | `web/src/hooks/use-chat.ts`、`components/chat-input/` | 7 |
| 9 | 单元测试补齐（§7.1） | `tests/` | 3,4,5 |
| 10 | 手工验证 + 回归（§7.2/§7.3） | — | 全部 |

任务 1+5 可并行；3→4 串行；6 依赖 4（事件经 coalesce 后才到路由）；9 可与 6/7/8 并行。

---

## 9. 风险与开放问题（请评审拍板）

| # | 问题 | 我的建议 | 备选 |
|---|---|---|---|
| Q1 | `finish` 帧是否同时保留 `result` 别名一版？ | **不留**（D6 无兼容期，同 PR 切换） | 保留一个迭代，双发事件 |
| Q2 | coalesce 放 harness 还是 server 路由？ | **harness**（所有 stream 消费者受益，路由无脑） | 路由层（改动小但 wait/其他宿主复用不到） |
| Q3 | 断连 `close` 即 abort 是否过激？（前端可能主动 cancel reader 再重连） | **abort**：当前无"断流续跑"语义，重连是全量拉消息（S2 才做断线续传）；白跑 token 比误杀更贵 | close 后宽限 N 秒再 abort |
| Q4 | `step-start` 现在发还是 S4 再发？ | **现在发**（一行的成本，前端 default 忽略即可，S4 直接用） | S4 再加 |
| Q5 | abort 时 `recordAssistantResult` 的 `thinkingDurationMs` 语义 | 保持"首个 text-delta 到达时间"，aborted 不影响该字段 | metadata 另加 abortedMs |
| Q6 | `run_start` 帧是否进 accumulator | **不进**（同 end/error 直发，避免 sessionId 到达被 pending 阻塞） | 进（更严格但无谓） |

---

## 10. 验收 Checklist（对齐 15 §2 S1 收尾）

- [ ] `curl -N` SSE 流事件名与 AI SDK chunk 类型逐一对齐，全部帧带 seq
- [ ] 首 token 到达时间不回退（coalesce 首 delta 立即发）
- [ ] 生成中调 abort 端点 → `finish { finishReason:"aborted" }` + 部分文本落库
- [ ] SSE 断连 → 服务端 run 被 abort（日志可见）
- [ ] `pnpm typecheck && pnpm test` 绿，无旧事件名残留
- [ ] UI stop 按钮可用，已产出内容保留

【完】

