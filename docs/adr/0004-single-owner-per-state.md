# 0004 每份状态只有一个所有者

- **Status**: Accepted
- **对应宪法条款**: C4

## 决策

每个模块必须能说清：拥有哪些表/文件/内存状态、维护哪些不变量、哪些操作能改它、
哪些是事实哪些是投影、谁能读谁能写。

**禁止模块 A 直接改模块 B 拥有的表**，跨模块写入必须调 B 的公开命令。

当前的完整归属表在 [`docs/current/data-ownership.md`](../current/data-ownership.md)。

## 为什么

两个写入者 = 没有不变量。Eva 里最贵的一条例子是 Run 终态：一旦有第二个地方能写
`runs` 的终态，台账里就会出现「settle 过又被 fail 覆盖」的行，而没有任何测试会红。

## 代价

有时要为一次跨模块写入多加一个公开命令，而不是直接 update 一行。

## 什么情况下推翻

不推翻。但**允许**为读加窄查询接口（见 [0006](./0006-ports-only-at-change-boundaries.md)
末尾的「能力收窄」），那不违反本条。

## 怎么验证

`vertical-module-public-entry`（lint:arch）+ code review 时对着归属表问一句「这份状态谁拥有」。
