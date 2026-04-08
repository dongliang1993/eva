import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveAgentRuntimeConfig
} from "../apps/server/src/agent.js";
import { loadConfig, type AppConfig } from "../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import {
  bootstrapLegacyLlmProviderConfig,
  createProvider,
  loadAppSettings,
  replaceAppSettings,
  updateProvider
} from "../apps/server/src/services/settings-store.js";

let db: AppDatabase;

const setDefaultModel = (
  config: AppConfig,
  modelId: string,
  temperature = 0.1
): void => {
  const current = loadAppSettings(db, config);

  replaceAppSettings(db, config, {
    ...current,
    chat: {
      ...current.chat,
      defaultModel: modelId,
      temperature
    }
  });
};

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
});

afterEach(() => {
  closeDb(db);
});

describe("agent runtime config", () => {
  it("prefers persisted settings and provider credentials over env LLM config", () => {
    const config = loadConfig({
      env: {
        LLM_API_KEY: "env-key",
        LLM_BASE_URL: "https://env.example/v1",
        LLM_MODEL: "gpt-4.1-mini"
      },
      cwd: "/tmp"
    });

    updateProvider(db, "openai", {
      enabled: true,
      apiKey: "db-key",
      baseURL: "https://db.example/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
      availableModels: [{ id: "gpt-4o", name: "GPT-4o" }]
    });
    setDefaultModel(config, "openai:gpt-4o", 0.7);

    const resolved = resolveAgentRuntimeConfig({ config, db });

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        mainModel: {
          providerId: "openai",
          modelId: "gpt-4o",
          apiKey: "db-key",
          baseURL: "https://db.example/v1",
          temperature: 0.7
        }
      }
    });
  });

  it("prefers the per-request model override over settings.defaultModel", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });

    updateProvider(db, "openai", {
      enabled: true,
      apiKey: "openai-key",
      models: [{ id: "gpt-4.1-mini", name: "gpt-4.1-mini" }],
      availableModels: [{ id: "gpt-4.1-mini", name: "gpt-4.1-mini" }]
    });
    createProvider(db, {
      id: "openrouter",
      name: "OpenRouter",
      type: "openrouter",
      apiKey: "openrouter-key",
      enabled: true,
      models: [{ id: "claude-3.7-sonnet", name: "claude-3.7-sonnet" }],
      availableModels: [{ id: "claude-3.7-sonnet", name: "claude-3.7-sonnet" }]
    });
    setDefaultModel(config, "openai:gpt-4.1-mini");

    const resolved = resolveAgentRuntimeConfig({
      config,
      db,
      requestedModelId: "openrouter:claude-3.7-sonnet"
    });

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        mainModel: {
          providerId: "openrouter",
          modelId: "claude-3.7-sonnet",
          apiKey: "openrouter-key",
          baseURL: "https://openrouter.ai/api/v1"
        }
      }
    });
  });

  it("exposes model capability limits on the resolved runtime binding", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });

    updateProvider(db, "openai", {
      enabled: true,
      apiKey: "openai-key",
      models: [{
        id: "gpt-4.1-mini",
        name: "gpt-4.1-mini",
        capabilities: {
          contextWindow: 256_000,
          maxOutputTokens: 16_000
        }
      }],
      availableModels: [{
        id: "gpt-4.1-mini",
        name: "gpt-4.1-mini",
        capabilities: {
          contextWindow: 256_000,
          maxOutputTokens: 16_000
        }
      }]
    });
    setDefaultModel(config, "openai:gpt-4.1-mini");

    const resolved = resolveAgentRuntimeConfig({ config, db });

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        mainModel: {
          contextWindow: 256_000,
          maxOutputTokens: 16_000
        }
      }
    });
  });

  it("bootstraps legacy env config into provider storage on a blank database", () => {
    const config = loadConfig({
      env: {
        LLM_API_KEY: "env-key",
        LLM_BASE_URL: "https://openrouter.ai/api/v1",
        LLM_MODEL: "claude-3.7-sonnet"
      },
      cwd: "/tmp"
    });

    bootstrapLegacyLlmProviderConfig(db, config);

    const resolved = resolveAgentRuntimeConfig({ config, db });

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        mainModel: {
          providerId: "openai",
          modelId: "claude-3.7-sonnet",
          apiKey: "env-key",
          baseURL: "https://openrouter.ai/api/v1"
        }
      }
    });
  });

  it("surfaces unsupported runtime provider types clearly", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });

    updateProvider(db, "anthropic", {
      enabled: true,
      apiKey: "anthropic-key",
      models: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }],
      availableModels: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }]
    });
    setDefaultModel(config, "anthropic:claude-sonnet-4-6");

    const resolved = resolveAgentRuntimeConfig({ config, db });

    expect(resolved).toEqual({
      ok: false,
      reason: 'Provider type "anthropic" is not supported for chat runtime yet.'
    });
  });
});
