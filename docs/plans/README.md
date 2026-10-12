# docs/plans —— 在建的施工计划

**新一轮的方案与任务拆分放这里。** 一轮做完就整体移进
[`docs/archive/plans/`](../archive/plans/)，别留在这里当"半个事实源"。

当前：harness 入参对齐 Claude Agent SDK —— 背景见 [`r14-harness-sdk-shape.md`](./r14-harness-sdk-shape.md)，可施工的 spec / plan / tasks 见 [`specs/001-harness-sdk-shape/`](../../specs/001-harness-sdk-shape/)。

## 这个目录与别处的分工

| 想知道 | 去哪 |
|---|---|
| 今天的代码长什么样 | [`docs/current/`](../current/) |
| 某个设计为什么这样定 | [`docs/adr/`](../adr/) |
| 某个 `T44` / `S27` 编号指的是什么 | [`docs/archive/plans/`](../archive/plans/) |
| Alma 竞品研究 | [`docs/archive/research/`](../archive/research/) |

## 写新计划的两条约定

1. **任务编号（`T…` / `S…`）只在这里出现。** 代码注释、AGENTS.md、`docs/current/`
   都不该拿编号当理解前提 —— 那些地方要写「为什么」，编号留给考古
   （[ADR 0012](../adr/0012-comments-explain-invariants.md)）。
2. **计划是目标，不是事实。** 落地后把当前事实更新进 `docs/current/`，
   稳定决策写成 ADR，然后把这一轮归档。
