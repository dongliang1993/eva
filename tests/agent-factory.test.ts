import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentFactory } from "../apps/server/src/services/agent-factory.js";
import { AgentUnavailableError } from "../apps/server/src/agent.js";
import { loadConfig, type AppConfig } from "../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import {
  loadAppSettings,
  replaceAppSettings
} from "../apps/server/src/services/settings/app-settings.js";
import { updateProvider } from "../apps/server/src/services/providers/provider-repository.js";
import type { AppInfrastructure } from "../apps/server/src/types/common.js";

let db: AppDatabase;

const setDefaultModel = (
  config: AppConfig,
  modelId: string,
  temperature = 0.1
): void => {
  const current = loadAppSettings(db, config);

  replaceAppSettings(db, config, {
    ...current,
    models: { chat: modelId },
    chat: {
      ...current.chat,
      temperature
    }
  });
};

const makeInfra = (): AppInfrastructure => ({
  config: loadConfig({ env: {}, cwd: "/tmp" }),
  db,
  skills: []
});

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);

  updateProvider(db, "openai", {
    enabled: true,
    apiKey: "openai-key",
    models: [{ id: "gpt-4o", name: "GPT-4o" }],
    availableModels: [{ id: "gpt-4o", name: "GPT-4o" }]
  });
  updateProvider(db, "anthropic", {
    enabled: true,
    apiKey: "anthropic-key",
    models: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }],
    availableModels: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }]
  });
});

afterEach(() => {
  closeDb(db);
});

describe("AgentFactory", () => {
  it("per-request modelId 覆盖默认模型", () => {
    const config = makeInfra().config;
    setDefaultModel(config, "openai:gpt-4o");
    const factory = new AgentFactory(makeInfra());

    expect(factory.resolve().mainModel.qualifiedModelId).toBe("openai:gpt-4o");
    expect(
      factory.resolve({ requestedModelId: "anthropic:claude-sonnet-4-6" })
        .mainModel.qualifiedModelId
    ).toBe("anthropic:claude-sonnet-4-6");
  });

  it("相同 binding 复用同一个 LanguageModel 实例", () => {
    const config = makeInfra().config;
    setDefaultModel(config, "openai:gpt-4o");
    const factory = new AgentFactory(makeInfra());

    factory.resolve();
    factory.resolve();

    expect(factory.modelCacheSize).toBe(1);
  });

  it("invalidate 后重建实例", () => {
    const config = makeInfra().config;
    setDefaultModel(config, "openai:gpt-4o");
    const factory = new AgentFactory(makeInfra());

    factory.resolve();
    expect(factory.modelCacheSize).toBe(1);

    factory.invalidate();
    expect(factory.modelCacheSize).toBe(0);

    factory.resolve();
    expect(factory.modelCacheSize).toBe(1);
  });

  it("无可用 provider 时抛 AgentUnavailableError(而不是在装配期崩)", () => {
    const dbEmpty = initDb({ dbPath: ":memory:" });
    migrateDb(dbEmpty);

    try {
      const factory = new AgentFactory({
        config: loadConfig({ env: {}, cwd: "/tmp" }),
        db: dbEmpty,
        skills: []
      });

      expect(() => factory.resolve()).toThrow(AgentUnavailableError);
    } finally {
      closeDb(dbEmpty);
    }
  });

  it("provider 变更后 invalidate,下次 resolve 拿到新配置", () => {
    const config = makeInfra().config;
    setDefaultModel(config, "openai:gpt-4o");
    const factory = new AgentFactory(makeInfra());

    expect(factory.resolve().mainModel.apiKey).toBe("openai-key");

    updateProvider(db, "openai", {
      apiKey: "rotated-key"
    });
    factory.invalidate();

    expect(factory.resolve().mainModel.apiKey).toBe("rotated-key");
  });
});

describe("AgentFactory 不依赖装配期单例", () => {
  it("无 API key 时装配不抛(解析发生在 resolve, 异步不可达)", () => {
    const bare = initDb({ dbPath: ":memory:" });
    migrateDb(bare);

    try {
      const infra: AppInfrastructure = {
        config: loadConfig({ env: {}, cwd: "/tmp" }),
        db: bare,
        skills: []
      };
      const factory = new AgentFactory(infra);

      // 构造本身绝不抛 —— 这是对「解析从装配期移到请求期」的回归。
      expect(factory).toBeInstanceOf(AgentFactory);
      expect(() => factory.resolve()).toThrow(AgentUnavailableError);
    } finally {
      closeDb(bare);
    }
  });
});