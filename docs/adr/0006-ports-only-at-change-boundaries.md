# 0006 只在变化边界使用 Port

- **Status**: Accepted
- **对应宪法条款**: C6

## 决策

**门槛是硬的：今天就存在第二个实现，或者跨 package 边界。** 两条都不满足就直接用具体类。

按这把尺子，Eva 里真正值得 Port 的只有四类：

| 值得 | 满足哪一条 |
|---|---|
| `LanguageModel`（AI SDK 提供） | 已有 5+ provider 实现；测试用 `MockLanguageModelV4` |
| MCP Client | 真有两种形态（stdio / http），且已有 `tests/helpers/fake-mcp-server.ts` |
| `CanUseTool`（server 实现 `createRunPermissions`） | 跨 package —— harness 绝不能知道 DB 与 SSE（0013 起取代 `RequestApproval` / `RequestPlanReview` / `PlanWeaveGateway`，见 [0013](./0013-harness-api-mirrors-agent-sdk.md)） |
| `Encryptor` | 今天就有两个实现：`AesGcmEncryptor` 与降级用的 `IdentityEncryptor` |

明确**不要** Port 的：每张表的 Repository、时钟、UUID、文件系统，以及任何只有一个实现的
纯业务类。不要造 `XxxStore` + `DrizzleXxxStore` 这样的成对文件。

## 为什么

「以后可能要换」不是变化边界 —— Eva 是本地优先桌面应用，SQLite 不会被换掉。
「方便测试」也不是：测试已经用真 SQLite（`initDb` + `migrateDb`），真库又快又保真。

## 但要区分「Port」与「能力收窄接口」

为**同一个实现**声明多个受限视图（曾经的例子是 `RunOpeningLedger` / `RunSettlingLedger`，已移除）不受本条约束，
而且鼓励使用：它不是为了替换实现，是为了让调用方**拿不到不该有的方法**，
把不变量交给编译器而不是 review。

判别方法：**Port 的两侧是不同实现；能力收窄的两侧是同一实现的方法子集。**

## 代价

将来真要换实现时，改动面比"处处都有 Port"更大。这是有意的取舍：
用一次可能的大改，换掉每天都要付的 indirection 税。

## 什么情况下推翻

某类存储真的出现第二个实现（比如为了同步引入远端存储）—— 那时按本条的门槛给它加 Port。
