import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../apps/server/node_modules/fastify";

import { loadConfig } from "../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import { registerProviderRoutes } from "../apps/server/src/routes/providers.js";
import { findProviderById } from "../apps/server/src/services/settings-store.js";

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
});
