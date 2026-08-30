# `AppApi` —— 应用用例层

Route 只拿到这一层，拿不到 `db`、`encryptor` 或任何 Repository（宪法 C2、宪章 §10.2 第 1、3 条）。

## 为什么存在

在 Wave 2 之前，10 个 route 文件里有 82 处直接访问 DB：`app.infra.db` 传给 service 函数、
`new DrizzleXxxRepository(app.infra.db)`、`import { messages } from "../db/schema.js"` 然后
自己拼 drizzle 查询。后果是 route 同时在当协议适配器和业务总控 —— 改一个查询要动 HTTP 层，
读一条 HTTP 端点要先读懂一段 SQL。

## 结构约定

一个能力一个文件，`<name>-api.ts`，导出一个 `create<Name>Api(deps)` 工厂和它的接口类型。
`index.ts` 是组合根的一部分：它是唯一 `new` Repository 的地方（§10.2 第 3 条）。

**Wave 4 的去处**：`api/<name>-api.ts` → `modules/<name>/index.ts`。这一层现在的形状就是
按那个终点选的 —— 每个文件将来就是那个模块的公开入口，所以它只导出用例与查询，
不导出 Repository。
