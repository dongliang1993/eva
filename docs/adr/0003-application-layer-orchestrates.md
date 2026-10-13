# 0003 应用层显式编排用例

- **Status**: Accepted（Wave 1 落地）
- **对应宪法条款**: C3

## 决策

应用层回答一个问题：**完成一个用户动作，需要按什么顺序调用哪些能力？**
顺序写在一个文件里，装配、审批、终态各自搬出去。

今天的形态：`Coordinator` 只有五个阶段的顺序（①输入 ②装配 ③上下文 ④开流 ⑤流式），
装配在 `run-runtime-builder`，审批在 `run-approval-channel`，终态在 `Coordinator.settle()`，
协议在 `route.ts`。

应用层可以依赖领域规则与 Port，不能依赖 Fastify Reply、SQL 细节或 React 状态。

## 为什么

「一次对话到底发生了什么」是这个仓库里被问得最多的问题。它必须能一口气读完，
而不是在 7 个文件之间跳。

## 代价

编排文件会随能力增加而变长。缓解办法是**只让顺序留在里面** —— 一旦某段细节需要
分支判断，它就该搬进被调用的能力里（harness 侧的对应决定见
[0013](./0013-harness-api-mirrors-agent-sdk.md)：query() 的主体只有顺序）。
见 [0010](./0010-run-scope-owns-lifecycle.md) 与
`docs/current/run-lifecycle.md`。

## 什么情况下推翻

如果 coordinator 开始出现「按 X 类型走不同顺序」的分支，说明那是两个用例，应该拆成两个，
而不是在里面加 if。

## 怎么验证

`docs/current/run-lifecycle.md` 的「五个文件读完一次对话」；`tests/server/runs/`。
