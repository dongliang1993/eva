/**
 * thread 重命名:PUT /api/v1/threads/:id {title}(右键重命名的后端出口)。
 */
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";

import { loadConfig } from "../../../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/db/repositories/session-repository.js";
import { registerThreadRoutes } from "../../../apps/server/src/routes/threads.js";
import { decorateAppApi } from "../../helpers/app-api.js";

let app: FastifyInstance;
let db: AppDatabase;

beforeEach(async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);

  app = Fastify();
  // 对齐 app.ts: 全局 ZodError → 400(裸 Fastify 没有它,校验失败会冒成 500)。
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: error.issues[0]?.message ?? "请求参数不合法" });
      return;
    }
    reply.send(error);
  });
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    db,
    logger: {} as never,
    skills: []
  });
  app.decorate("services", {
    // listThreadSummaries 要用 approvals.listPending 算 status,给个空 stub。
    approvals: { listPending: () => [] }
  } as never);
  decorateAppApi(app);
  registerThreadRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDb(db);
});

const seedThread = (title = "原始标题"): string => {
  const id = randomUUID();
  new DrizzleSessionRepository(db).create({ id, title });
  return id;
};

describe("PUT /api/v1/threads/:id 重命名", () => {
  it("改标题 → 200 + 返回更新后的 summary", async () => {
    const id = seedThread();
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/threads/${id}`,
      payload: { title: "新名字" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("新名字");
    // 落库了
    expect(new DrizzleSessionRepository(db).findById(id)?.title).toBe("新名字");
  });

  it("不存在的 thread → 404", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/threads/${randomUUID()}`,
      payload: { title: "x" }
    });
    expect(res.statusCode).toBe(404);
  });

  it("空标题 / 超长 → 400(zod)", async () => {
    const id = seedThread();
    expect(
      (await app.inject({ method: "PUT", url: `/api/v1/threads/${id}`, payload: { title: "" } }))
        .statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/threads/${id}`,
          payload: { title: "a".repeat(201) }
        })
      ).statusCode
    ).toBe(400);
  });
});
