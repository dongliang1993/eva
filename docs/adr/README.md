# ADR —— 架构决策记录

一条 ADR 记一个**稳定决策**：它为什么这样定、放弃了什么、什么情况下应该被推翻。

- **不记施工历史。** 任务编号（`T44`、`S27` …）留在 `docs/plans/` 与 git 里。
- **不记当前事实。** 「今天代码长什么样」在 [`docs/current/`](../current/)。
- 一条 ADR 被推翻时**不删**：把 Status 改成 `Superseded by NNNN`，新写一篇。

0001–0012 是 Eva 的十二条架构宪法，原文出自架构改造总纲（现已归档到
`docs/archive/plans/25-eva-simple-architecture-charter.md`）的 §3。它们在 Wave 0–5
的改造里逐条被真正执行过，因此状态是 Accepted 而不是 Proposed。

| # | 决策 | 一句话 |
|---|---|---|
| [0001](./0001-dependency-direction.md) | 依赖只能朝稳定方向流动 | 外层认识内层，内层不认识外层 |
| [0002](./0002-protocol-layer-only-translates.md) | 协议层只翻译协议 | Route 不碰 DB、不装 agent、不定策略 |
| [0003](./0003-application-layer-orchestrates.md) | 应用层显式编排用例 | 顺序写在一个能读完的地方 |
| [0004](./0004-single-owner-per-state.md) | 每份状态只有一个所有者 | 跨模块写入只能调公开命令 |
| [0005](./0005-derive-instead-of-duplicate.md) | 能推导的状态不重复存储 | 第二份可变状态要付维护费 |
| [0006](./0006-ports-only-at-change-boundaries.md) | 只在变化边界使用 Port | 门槛是硬的：今天就有第二实现，或跨 package |
| [0007](./0007-direct-calls-events-for-side-projections.md) | 控制流直接调用，旁路投影用事件 | 主链顺序不许藏进事件总线 |
| [0008](./0008-composition-root-only.md) | 具体实现只在组合根装配 | `new Repository` 只有一个地方 |
| [0009](./0009-single-module-entry.md) | 每个模块只有一个公开入口 | 跨模块只从 `index.ts` 进 |
| [0010](./0010-run-scope-owns-lifecycle.md) | 生命周期资源由 Scope 管理 | 一次 Run 的资源集中释放 |
| [0011](./0011-structured-errors.md) | 错误必须结构化 | 不靠匹配错误字符串决定业务行为 |
| [0012](./0012-comments-explain-invariants.md) | 注释解释不变量，不记施工历史 | 读代码不该需要先懂任务编号 |
