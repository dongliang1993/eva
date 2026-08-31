# 0007 控制流用直接调用，旁路投影用事件

- **Status**: Accepted
- **对应宪法条款**: C7

## 决策

必须立刻成功、失败会改变主流程的行为 → **显式调用**：

```text
open session → resolve runtime → execute agent → persist message → settle run
```

同一事实发生后由多个消费者各自独立处理的旁路行为 → **事件**：

```text
tool_call_completed → observability append / SSE 投影 / UI 消息投影 / usage 投影
```

**禁止用全局事件总线隐藏核心业务顺序**；关键持久化不能只依赖「希望某个订阅者稍后处理」。

## 为什么

事件总线会把「顺序」变成「时序巧合」：出问题时没有一个地方能读出应该发生什么。
Eva 的观测层（`run_events`）是订阅者，它挂掉不该让对话失败 —— 这正是它适合做事件的原因。

## 代价

主链上的调用是硬耦合的，加一个必做步骤要改编排文件（这是好事：那次修改会被 review 看到）。

## 什么情况下推翻

不推翻。要加旁路消费者时走事件，不要把主链步骤挪成事件。

## 怎么验证

`record` 绝不抛回 agent loop（`modules/observability/run-recorder.ts`）；
`tests/server/observability/`。
