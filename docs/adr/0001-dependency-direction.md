# 0001 依赖只能朝稳定方向流动

- **Status**: Accepted（2026-08-30 起由 `pnpm lint:arch` 强制）
- **对应宪法条款**: C1

## 决策

外层可以依赖内层，内层不能反向认识外层：

```text
apps/web ─┐
apps/desktop ─┼─▶ packages/shared
Server 协议层 ─┴─▶ Server 应用层 ─▶ 领域规则 / packages/harness / Ports
                                        ▲
                        Infrastructure ─┘ implements
```

仓库级允许的编译依赖：

| 来源 | 允许 | 禁止 |
|---|---|---|
| `apps/web` | `@eva/shared`、Web 内部 | `apps/server`、`@eva/harness`、数据库 |
| `apps/desktop` | 桌面内部、必要的 shared 契约 | Server 内部 service、harness 内部实现 |
| `apps/server` | `@eva/harness`、`@eva/shared` | web、desktop |
| `packages/harness` | `@eva/shared`、AI SDK | Fastify、Drizzle、Eva DB、React、Electron |
| `packages/shared` | 极少量纯协议依赖 | 上面全部 |

## 为什么

依赖方向是唯一能靠脚本判定、又能真正阻止腐化的结构约束。harness 一旦认识 Drizzle，
「agent 内核」就变成了「server 的一部分」，它的测试也就不再能只用假模型跑。

## 代价

偶尔要为跨层传递多写一个类型（`@eva/shared` 里的契约），不能图快直接 import 对面的实现。

## 什么情况下推翻

出现第二个宿主（比如纯 CLI），且它需要 harness 直连自己的存储 —— 那时该讨论的是给
harness 加一个 Port，而不是放开方向。

## 怎么验证

`pnpm lint:arch` 的依赖方向类规则；违反时 CI 的「架构边界」步骤直接失败。
