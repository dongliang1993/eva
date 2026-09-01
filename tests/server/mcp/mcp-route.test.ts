import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";
import { ZodError } from "zod";

import { loadConfig } from "../../../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { IdentityEncryptor } from "../../../apps/server/src/infrastructure/crypto/encryptor.js";
import {
  McpConfigStore,
  McpRegistry,
  registerMcpServerRoutes
} from "../../../apps/server/src/modules/mcp/index.js";
import { decorateAppApi } from "../../helpers/app-api.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

let db: AppDatabase;
let app: FastifyInstance;
let dir: string;
let store: McpConfigStore;

beforeEach(async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  dir = mkdtempSync(path.join(tmpdir(), "eva-mcp-route-"));
  store = new McpConfigStore(path.join(dir, "mcp.json"));

  app = Fastify();

  // ZodError→400 的 handler 装在 buildApp(app.ts),手搭 fixture 里补一份同款
  // —— 路由把校验托付给它,不装的话 ZodError 冒泡成 500,测的就不是真契约。
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: error.issues[0]?.message ?? "请求参数不合法" });
      return;
    }

    throw error;
  });
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    db,
    logger: {} as never,
    skills: [],
    // mcp 用例不碰密钥,但 AppInfrastructure 类型要求 —— 明文直通即可
    encryptor: new IdentityEncryptor()
  });
  app.decorate("services", {
    // 真连会 spawn 进程,路由测试只关心写路径的形状 → 假 connect 永远报连接失败。
    // mcpStore 传测试 store —— api(写)与 registry(读)必须看同一个文件。
    mcpStore: store,
    mcp: new McpRegistry(store, logger(), async () => {
      throw new Error("not under test");
    })
  } as never);
  decorateAppApi(app);
  registerMcpServerRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

const addServer = () =>
  store.create({
    name: "figma",
    transport: "stdio",
    command: "npx",
    args: []
  });

describe("PUT /api/v1/mcp-servers/:id", () => {
  it("只发 {enabled} 也能启停(列表行开关的形状)", async () => {
    const server = addServer();

    const off = await app.inject({
      method: "PUT",
      url: `/api/v1/mcp-servers/${server.id}`,
      payload: { enabled: false }
    });

    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(false);
    expect(store.findById(server.id)!.enabled).toBe(false);
  });

  it("发完整配置走 update;env 值直通往返", async () => {
    const server = addServer();

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/mcp-servers/${server.id}`,
      payload: {
        name: "figma",
        transport: "stdio",
        command: "npx",
        args: ["-y"],
        env: { FIGMA_API_KEY: "secret-value" },
        autoApproveTools: [],
        enabled: true
      }
    });

    expect(response.statusCode).toBe(200);
    // 值回传是新契约:响应里带 env 的值,不是只有 key 名
    expect(response.json().env).toEqual({ FIGMA_API_KEY: "secret-value" });
    expect(store.findById(server.id)!.args).toEqual(["-y"]);
  });

  it("改名撞别的 server 名 → 409", async () => {
    addServer();
    store.create({ name: "other", transport: "stdio", command: "x" });

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/mcp-servers/figma",
      payload: {
        name: "other",
        transport: "stdio",
        command: "npx",
        args: [],
        env: {},
        autoApproveTools: [],
        enabled: true
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("other");
    // 被撞名的条目没被动过
    expect(store.findById("other")!.command).toBe("x");
  });

  it("非 enabled-only 的残缺 body 仍是 400(带具体校验信息)", async () => {
    const server = addServer();

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/mcp-servers/${server.id}`,
      payload: { name: "figma" }
    });

    expect(response.statusCode).toBe(400);
    // 判别联合的报错:指出 transport 缺了哪些合法值
    expect(response.json().error).toContain("stdio");
  });

  it("不存在的 id → 404", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/mcp-servers/nope",
      payload: { enabled: false }
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("DELETE /api/v1/mcp-servers/:id", () => {
  it("从 mcp.json 移除条目", async () => {
    const server = addServer();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/mcp-servers/${server.id}`
    });

    expect(response.statusCode).toBe(204);
    expect(store.findById(server.id)).toBeUndefined();
  });
});

describe("POST /api/v1/mcp-servers", () => {
  it("创建写进文件,重名 409", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mcp-servers",
      payload: {
        name: "km",
        transport: "http",
        url: "https://km.example.com/mcp",
        headers: { Authorization: "Bearer t" },
        autoApproveTools: [],
        enabled: true
      }
    });

    expect(created.statusCode).toBe(201);
    expect(store.findById("km")!.url).toBe("https://km.example.com/mcp");

    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/mcp-servers",
      payload: {
        name: "km",
        transport: "http",
        url: "https://other.example.com/mcp",
        autoApproveTools: [],
        enabled: true
      }
    });

    expect(conflict.statusCode).toBe(409);
    // 撞名创建不覆盖已有条目
    expect(store.findById("km")!.url).toBe("https://km.example.com/mcp");
  });
});
