import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";

import { loadConfig } from "../../../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { registerProviderRoutes } from "../../../apps/server/src/modules/providers/index.js";
import {
  findProviderById,
  updateProvider
} from "../../../apps/server/src/modules/providers/index.js";
import { decorateAppApi } from "../../helpers/app-api.js";

let app: FastifyInstance;
let db: AppDatabase;

beforeEach(async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);

  app = Fastify();
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    sentryClient: {} as never,
    waveClient: undefined,
    db,
    skills: []
  });
  app.decorate("services", {
    agents: { invalidate() { /* no-op in this fixture */ } }
  } as never);
  decorateAppApi(app);

  registerProviderRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDb(db);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Provider runtime routes", () => {
  it("returns cached provider models in the Alma-compatible shape", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/providers/openai/models"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: expect.arrayContaining(["gpt-4.1-mini"]),
      models: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-4.1-mini", name: "gpt-4.1-mini" })
      ])
    });
  });

  it("updates enabled models through the dedicated models route", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/models",
      payload: {
        models: [
          {
            id: "gpt-4o",
            name: "GPT-4o"
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "openai",
      models: [{ id: "gpt-4o", name: "GPT-4o" }]
    });
  });

  it("tests provider connectivity against the server-side provider API", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-4.1-mini", name: "GPT-4.1 Mini" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/providers/openai/test",
      payload: {
        apiKey: "sk-test"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      latencyMs: expect.any(Number)
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test"
        })
      })
    );
  });

  it("fetches remote models and caches them back into the provider record", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-5-mini", name: "GPT-5 Mini" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/providers/openai/models/fetch",
      payload: {
        apiKey: "sk-test"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: expect.arrayContaining(["gpt-5-mini"]),
      models: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5-mini", name: "GPT-5 Mini" })
      ])
    });

    expect(findProviderById(db, "openai")).toMatchObject({
      availableModels: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5-mini", name: "GPT-5 Mini" })
      ])
    });
  });

  describe("GET /api/v1/providers/:id/api-key(揭示端点)", () => {
    it("已存 key → 返回解密后的明文", async () => {
      updateProvider(db, "openai", { apiKey: "sk-reveal-me" });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/providers/openai/api-key"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ apiKey: "sk-reveal-me" });
    });

    it("未存 key → 返回空串", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/providers/openai/api-key"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ apiKey: "" });
    });

    it("provider 不存在 → 404", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/providers/no-such-provider/api-key"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Provider not found" });
    });

    it("列表响应仍不含明文 key(坑 2 不回流)", async () => {
      updateProvider(db, "openai", { apiKey: "sk-should-not-leak" });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/providers"
      });

      expect(response.statusCode).toBe(200);
      const providers = response.json() as readonly Record<string, unknown>[];
      const openai = providers.find((provider) => provider.id === "openai");
      expect(openai).toMatchObject({ hasApiKey: true });
      expect(openai).not.toHaveProperty("apiKey");
    });
  });
});
