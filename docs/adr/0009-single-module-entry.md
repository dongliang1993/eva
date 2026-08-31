# 0009 每个模块只有一个公开入口

- **Status**: Accepted（Wave 4 起 `vertical-module-public-entry` 为 error，锁住全部 17 个模块）
- **对应宪法条款**: C9

## 决策

跨模块只能从目标模块的 `index.ts`（或明确的 package subpath）导入。
模块内部文件默认私有 —— 禁止为了方便直接 import 别人的 Repository、internal 或临时 helper。

## 为什么

公开入口是模块的契约面。没有它，"模块"只是一个目录名：任何人都能依赖任何文件，
于是任何文件都不能改名。

## 代价

要在 `index.ts` 上显式 re-export，多一行。这一行就是契约：加它的时候你会想一下
「这个真的要给外面看吗」。

## 边界情况

Repository 类**可以**从 `index.ts` 导出，但只给组合根用（见
[0008](./0008-composition-root-only.md)）。这不是漏洞：组合根本来就是唯一能 new 它的地方。

## 怎么验证

`pnpm lint:arch`：`vertical-module-public-entry`。
