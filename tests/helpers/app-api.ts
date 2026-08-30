import type { FastifyInstance } from "fastify";

import { buildAppApi } from "../../apps/server/src/api/index.js";

/**
 * 给手搭的 fixture app 补上 `app.api` 装饰。
 *
 * 在 `app.decorate("infra", ...)` 与 `app.decorate("services", ...)` **之后**调用 ——
 * 它读那两个装饰,再用**真的** `buildAppApi` 拼出用例层。用真的而不是再造一个假的:
 * 「route 只经 AppApi 拿数据」这条边界如果在测试里绕过去,Wave 2 的退出条件就没有判据了。
 *
 * fixture 的 infra/services 通常是部分填充(`as never`),有的干脆不装 services。
 * 这没问题 —— buildAppApi 只在**构造期**读 db / config / logger 与四个长寿服务的引用,
 * 缺的那些要等对应用例被调用才会被碰到,而只测某几条路由的 fixture 不会调到它们。
 * 真调到了就是 TypeError,不会静默返回错数据。
 */
export const decorateAppApi = (app: FastifyInstance): void => {
  app.decorate("api", buildAppApi(app.infra, app.services ?? ({} as never)));
};
