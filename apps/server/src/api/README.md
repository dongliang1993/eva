# `AppApi` —— route 能看到的全部东西

Route 只拿到这一层，拿不到 `db`、`encryptor` 或任何 Repository（宪法 C2，
[ADR 0002](../../../../docs/adr/0002-protocol-layer-only-translates.md)）。

## 为什么存在

在 Wave 2 之前，10 个 route 文件里有 82 处直接访问 DB：`app.infra.db` 传给 service 函数、
`new DrizzleXxxRepository(app.infra.db)`、`import { messages } from "../db/schema.js"` 然后
自己拼 drizzle 查询。后果是 route 同时在当协议适配器和业务总控 —— 改一个查询要动 HTTP 层，
读一条 HTTP 端点要先读懂一段 SQL。

## 今天的形状

这个目录只剩 `index.ts`。每个能力的 API 已经在 Wave 4 搬进了它自己的模块
（`modules/<name>/api.ts`，由 `modules/<name>/index.ts` 导出 `create<Name>Api`），
`index.ts` 做两件事：

1. `new` 那些被多个模块共用的 Repository（组合根的一部分，宪法 C8）；
2. 把各模块的 `create<Name>Api(...)` 拼成一个按能力分组的 `AppApi`，`app.decorate("api", …)`。

**加一条 route 需要的查询时**：在对应模块的 `api.ts` 上加方法，不要把 `db` 递过去。
`lint:arch` 的 `routes-only-app-api` / `routes-no-db` / `repository-only-in-composition-root`
三条规则会扫每个 `modules/*/…route.ts`。

> Repository 的**创建**并没有全部收在这里：`modules/` 下还有 17 个文件自己 `new`
> （其中一部分 new 的是别的模块的）。那是 Wave 4 的存量债，见
> [ADR 0008](../../../../docs/adr/0008-composition-root-only.md)。新代码别再加。
