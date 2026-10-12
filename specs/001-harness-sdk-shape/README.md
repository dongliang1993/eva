# 001 · Harness API 对齐 Claude Agent SDK

给实现者的入口。按顺序读：

| # | 文件 | 回答什么 |
|---|---|---|
| 1 | [`spec.md`](./spec.md) | 要什么、不要什么、怎么算做完（FR / SC） |
| 2 | [`plan.md`](./plan.md) | 怎么做：目标结构、关键设计决定、**§4 代码风格约束** |
| 3 | [`contracts/harness-api.ts`](./contracts/harness-api.ts) | harness 公开类型的唯一事实源 |
| 4 | [`tasks.md`](./tasks.md) | 四个任务，按顺序做，每个任务一次验收 |

还要读：仓库根 `AGENTS.md`、`docs/current/run-lifecycle.md`、`tests/README.md`。

## 三条最容易违反的规则

1. **用户可见行为与文案逐字不变。** 模型看到的拒绝 / 错误 / plan 文案、SSE 帧、`run_events` 的 kind 与 payload。
   对不上就是 bug，不是「新设计的自然结果」。
2. **测试只改调用形状，不改行为断言。** 必须改的，在 PR 描述里逐条说明。
3. **只做本任务的事。** 看见别的问题写进 PR 的「发现」一节，不顺手修。

## 交付格式

每个任务一个 PR，描述包含：改了什么 / 删了哪些测试与断言及替代 / 发现。
提交前跑：`pnpm typecheck && pnpm lint:arch && pnpm test`（碰了 web 加 `pnpm web:build`）。
