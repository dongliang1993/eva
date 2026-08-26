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
