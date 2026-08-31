# 0002 协议层只翻译协议

- **Status**: Accepted（Wave 2 起 `routes-only-app-api` / `routes-no-db` 为 error）
- **对应宪法条款**: C2

## 决策

HTTP/SSE route 只能做五件事：请求解析与 Zod 校验、调用**一个**应用用例、
把领域错误映射成 HTTP 状态码、把应用事件编码成 SSE、处理连接建立与断开。

route 禁止：直接访问 DB、`new XxxRepository()`、组装 agent、决定审批策略、
构造 Plan/Memory/Subagent runtime、修改多个模块的状态、包含产品级事务流程。

落地形态：route 只能看到 `app.api`（`AppApi`），看不到 `db` 与 `encryptor`。

## 为什么

Wave 2 之前 10 个 route 文件里有 82 处直接访问 DB。后果不是"不优雅"，是**改一个查询要动
HTTP 层，读一条端点要先读懂一段 SQL** —— route 同时在当协议适配器和业务总控。

## 代价

给 route 加一个查询要先在对应模块的 `api.ts` 上加一个方法，多一步。这一步是有意的：
它让「谁能读什么」变成一份可以读完的清单。

## 什么情况下推翻

不推翻。真需要临时排查时，写一次性脚本，不要在 route 里开洞。

## 怎么验证

`pnpm lint:arch`：`routes-only-app-api`（连 `app.infra` / `app.services` 一起禁）、`routes-no-db`。
