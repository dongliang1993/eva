# 0008 具体实现只能在组合根装配

- **Status**: Accepted（Wave 2 起 `repository-only-in-composition-root` 为 error）
- **对应宪法条款**: C8

## 决策

具体基础设施对象（Repository、Provider Client、MCP Client）由组合根装配。
Eva 的组合根：`apps/server/src/deps.ts`（基础设施）、`services/index.ts`（业务服务）、
`api/index.ts`（route 能看到的全部东西）。

组合根必须是回答这个问题的唯一位置：**Eva 运行时到底由哪些具体实现组成？**

## 今天到哪一步（2026-08-31 实测）

- **route 一侧已经成立并加锁**：`lint:arch` 的 `repository-only-in-composition-root`
  扫 `routes/` 与每个 `modules/*/…route.ts`，route 里 `new XxxRepository(` 直接 error。
- **模块内部还没有。** `apps/server/src/modules/` 下有 **17 个文件**自己 `new` Repository，
  其中一部分 new 的是**别的模块**的：`modules/compact/*` 建 sessions 的两个、
  `modules/sessions/session-status.ts` 与 `session-usage.ts` 建 runs 的、
  `modules/observability/*` 建 runs 的、`modules/runs/run-repository.ts` 建 usage 的。
  这是 Wave 4 划完模块边界后留下的债 —— 它同时也弱化了
  [ADR 0004](./0004-single-owner-per-state.md)：跨模块直接 new 对方的 Repository，
  等于绕过对方的公开命令去写它的表。
- 收敛路径是**先把跨模块的那些换成调对方 `index.ts` 的公开命令**，再把「模块内部只在
  `api.ts` 装配」升成规则。没做之前，这一条对模块内部只是**方向**，不是现状。

## 为什么

到处 `new` 的后果是「换一个实现要 grep 全仓库」，以及测试里悄悄连上真依赖。
更实际的收益是：读一个文件就能知道这个进程由什么组成。

## 代价

依赖要一路传进去，构造参数会变长。对策是按能力分组（`AppApi` / `AppServices`），
不是把 `db` 递给所有人 —— 后者正是 [0002](./0002-protocol-layer-only-translates.md) 要禁的。

## 一个已经踩过的形态

> **2026-10-12 现状：** `RunFinalizer` 与 `RunOpeningLedger` / `RunSettlingLedger` 已随执行内核重建移除。
> 终态现在只有 `Coordinator.settle()` 一个出口，由 `runs.settle` 的条件更新（只改 `status = 'running'`）在数据库层兜底，
> 不再由编译器守。下文描述的是当时的形态。

`RunFinalizer` 是 per-run 的（持 runId / hub / failureLayer），但 coordinator 不能拿到
`RunSettlingLedger`。解法是组合根提供一个**工厂**：coordinator 只能「要一个 finalizer」，
不能自己 new。自己 new 就等于手里有了那个类型，能力收窄立刻白做。

## 怎么验证

`pnpm lint:arch`：`repository-only-in-composition-root`。（`run-ledger-terminal-state` 已随窄接口一起移除。）
