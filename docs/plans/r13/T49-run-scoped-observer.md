# T49 · run-scoped observer 与事件补齐

> 前置：T47（recorder）、T48（Run 行与父子关系）。读 `00-overview.md` §3 契约 3、4。
> 方案出处：设计文档 §3.2、§2、§8。

## 1. 问题

observer 现在是进程级单例：`deps.ts:34` 建一次，挂在 `AppInfrastructure.observer`，主代理（`agent-factory.ts:375`）和子代理（`:459`）拿的是同一个引用。事件本身也不带身份 —— `AgentTelemetryEvent`（`observer.ts:37`）既没有 runId 也没有 agent 判别。

所以现状下多个并发 Run 的事件是混在一条流里的，而且**无法事后分开**。跨会话并发是钉住的产品行为（`tests/run-concurrency.test.ts:145`），后台子代理还能越过父 Run 存活，所以「用一个隐式 current run 归属事件」这条路不成立：新主 Run、旧 Run 遗留的后台子代理、新 Run 自己的子代理可以同时在发事件。

只能显式绑定。

## 2. 改动

### 2.1 事件类型扩容

`packages/harness/src/agents/observer.ts`：

- 每个事件加 `readonly agent: "main" | string`（taskId）。
- 补齐第一版 kind（对照 T47 §2.1 的清单）：现有 8 类只覆盖 run start/end、llm start/end、tool initiated/completed、repaired、transition。缺 Turn、Step、first-token、model_call_failed、assistant_message、approval、request_snapshot、context_overflow、终态区分。
- `tool_call_completed` 的 `durationMs: number`（`observer.ts:70`，现在是必填）改成三段可选字段，由 T50 填。本卡先把类型开出来，值可以先是 `undefined`。

`AgentObserver` 的形状不变 —— 它仍是 `(event) => void`，只是事件更丰富。**不要**把 runId 塞进事件；runId 属于绑定关系，不属于事件内容。

### 2.2 run-scoped 绑定

`AgentBuildOptions`（`agent-factory.ts:78`）与 `buildSubagent`（`:405`）各加一个必填的 observer 参数，替掉 `...defined("observer", this.infra.observer)`（`:375`、`:459`）。

`routes/runs.ts` 在 `runLedger.start` 之后建 recorder，包成 observer 传进 `agents.build`：

```ts
const recorder = createRunRecorder(deps, { runId, sessionId });
const observer = toObserver(recorder, { agent: "main" });
```

前台子代理在 `subagent-runner.ts` 里用**同一个 recorder**、不同 agent 值：`toObserver(recorder, { agent: taskId })`。后台子代理用它自己 Run 的 recorder（T48 §2.3）。

`deps.ts:34` 的 Pino observer 保留 —— 它是第二个订阅者，不是被替换对象。两个 observer 用一个 `fanout(...)` 合并；ledger 写失败不影响 Pino 输出，反之亦然。

**禁止**在 `run-registry.ts` 或任何单例上放「当前 run」字段（契约 3）。

### 2.3 agent.ts 事件补齐

落点（行号为 S26 之后）：

| 事件 | 位置 |
|---|---|
| `turn_started` / `turn_completed` | run 循环外层；一次用户输入到终态算一个 Turn |
| `step_started` / `step_completed` | `onStepStart` `agent.ts:384`、`onStepEnd` `:388` |
| `model_first_token` | 拉流循环 `:434` 附近，该 Step 第一条 text/reasoning/tool-call delta |
| `model_call_failed` | `:511` 之后的 error 分支（区分 retry 与终态） |
| `assistant_message` | finish 汇总处 `:666` |
| `tool_call_started` | 已有 `tool_call_initiated`（`:458-461`），改名对齐清单 |
| `context_compacted` | 现有 `emitCompaction`（`:198`）的三个调用点 |
| `loop_transition` | 现有 `emitTransition`（`:214`），已有 5 个调用点 |
| `run_completed` / `run_failed` | `finish()` 与抛出路径，带 `failure_layer` |

`attempt` 字段用于 reactive compact retry（`:506-511`）与 repair 重试 —— 同一 Step 的第二次尝试是新事件、不是覆盖。

### 2.4 失败归因

`failure_layer` 在事件里定，settle 时写进 `runs`（T48 §2.1）：`routing`（provider/模型/skill 解析）、`model`（流式报错、上下文溢出）、`tool`（工具执行异常）、`context`（压缩失败）、`orchestration`（loop/装配）、`unknown`。**`cancelled` 不进这个枚举** —— 用户中止是 `status=aborted`，不是失败层。

## 3. 验收

- 两个不同 Session 同时跑 run：各自 `run_events` 只含自己的事件，两条 Run 的 seq 各自连续。
- 前台子代理跑完：事件在父 Run 的 ledger 里，`agent` = taskId，与主 Agent 事件共用一个 seq 序列且不冲突。
- 后台子代理跑完：事件全在它自己的 Run 里，父 Run ledger 无子代理事件。
- 一次含并行工具调用的 Run，只读 `run_events` 就能投影出 Turn → Step → Request → Assistant → Tool 的完整结构，不需要读 `messages`。
- 同一 Step 触发 reactive compact retry 后重跑：两次尝试是两组事件，`attempt` 分别为 1 和 2。
- Pino 输出与落库互不影响：手工让 recorder.append 抛错，Pino 日志照常、run 照常跑完。
- `grep -rn "currentRun" apps/server/src` 零命中。

## 4. 实施备注（含三个顺带修掉的存量 bug）

**设计取舍**：§2.1 的「每个事件加 `agent` 字段」没有落在 harness 事件联合上 —— agent 与 runId 同属绑定关系（卡自己也是这么说的），落在 `RunEventInput.agent`（recorder 入参）。harness 事件保持身份无感，`createObserverBridge(recorder).forAgent(agent)` 一处绑定。`fanout` 合并 Pino 第二订阅者，任一订阅者抛错互不影响（agent.ts `emit` 自身还有第三层 try）。

**Turn 语义纠偏（落地后用户评审发现）**：初版把 notice 续跑标成 `turnIndex++`（开新 Turn)，与本卡自己的定义矛盾 —— 「一次用户输入到终态算一个 Turn」，续跑发生在终态之前，属于同一个 Turn（只是多一些 Step，边界由 `loop_transition(subagent_notice)` 表达）。已改回：`turnIndex` 在一个 Run 内恒为 0。对照 DSH(`agent-loop/agent.ts`)：它没有 run,turn = 一次唤醒到排空，唤醒消息分 `next-step`（并进当前 turn 的下一 step）与 `next-turn`（开新 turn）两档 —— Eva 的「注入即续跑一圈」是请求级 Run 内的续跑，按卡面定义不开新 Turn。

**bug 1：ai@7 不允许 `messages` 里出现任何 system 角色，两个存量路径因此必炸。**
- `run-preparation.ts:223` 把会话摘要放成 leading system 消息 → **被 compact 过的会话每次 run 都以 InvalidPromptError 终**（已用路由级复现钉死）。
- reactive compact 的 reminder system 消息插在中段 → retry 那一圈 streamText 直接抛。
- 修复：`agent.ts` 在每次 streamText 前把 `messages` 里的 system 消息统一上提到 `createPrepareStep` 的 `extraInstructions`（这正是 context-strategy.ts:53 注释写明的本意，只是校验发生在 prepareStep 之前，hoist 必须提前到 agent.ts）。

**bug 2：`prefixMessageCount` 在续写/notice 续跑后漂移 → 孤儿 tool-call。** 续跑分支把 `messages` 换成 `responseMessages + 续写消息`（不含最初输入），静态 prefix 语义失效；reactive compact 按旧 prefix 切，把 tool-call 留在「prefix」、其 tool result 压进 summary，`AI_MissingToolResultsError`。修复：两个续跑分支里 `prefixMessageCount = 0`。

**bug 3：SDK 对失败 step 也迟发 `onStepEnd`（且在下一轮 streamText 处理中才到）。** 不修的话失败 step 白占步数、retry 拿到新下标，卡验收的「同 Step，attempt 1→2」不成立。修复：`failedStepIndex` 标记 + `onStepEnd` 跳过迟到的失败回调（不占步数、不发 `llm_call_end`、不累计用量）。副作用：失败模型调用不再消耗 maxSteps 预算（更合理，但属行为变化，记录在此）。

**测试基建结论**：
- `MockLanguageModelV4` 的 `finishReason: "length"` 会被归一成 `"other"`，max-output 续写端到端在 mock 下不可达（与 lead-agent-loop.test.ts:250 的既有结论一致）；reactive retry 端到端改走 notice 续跑圈触发。
- `finish-step` part 可能在 `onStepEnd` 之后才到 —— `model_call_completed`/`model_first_token` 的 step 归属用 `streamingStepIndex`（onStepStart 定格），不能用 `stepsUsed`。
- route 级测试桩要 honor `options.observer`（`createAgent({observer: opts.observer})`），否则 harness 事件到不了 ledger。
