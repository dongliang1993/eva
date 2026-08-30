import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../../../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import {
  resolveModelSlot,
  updateProvider,
} from "../../../apps/server/src/modules/providers/index.js";
import {
  loadAppSettings,
  replaceAppSettings
} from "../../../apps/server/src/modules/settings/index.js";

let db: AppDatabase;

const setModel = (config: AppConfig, slot: "chat" | "tool" | "embedding", modelId: string): void => {
  const current = loadAppSettings(db, config);
  replaceAppSettings(db, config, {
    ...current,
    models: { ...current.models, [slot]: modelId }
  });
};

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
});

afterEach(() => {
  closeDb(db);
});

describe("resolveModelSlot", () => {
  it("解析持久化的 provider 凭据", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });
    updateProvider(db, "openai", {
      enabled: true,
      apiKey: "db-key",
      baseURL: "https://db.example/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
      availableModels: [{ id: "gpt-4o", name: "GPT-4o" }]
    });
    setModel(config, "chat", "openai:gpt-4o");

    // chat 槽位无全局默认兜底:override 是唯一来源(此处显式传)。
    const resolved = resolveModelSlot(db, config, "chat", "openai:gpt-4o");

    expect(resolved).toMatchObject({
      ok: true,
      binding: {
        providerId: "openai",
        modelId: "gpt-4o",
        apiKey: "db-key",
        baseURL: "https://db.example/v1",
        qualifiedModelId: "openai:gpt-4o"
      }
    });
  });

  it("override 优先于 settings", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });
    updateProvider(db, "openai", {
      enabled: true,
      apiKey: "openai-key",
      models: [{ id: "gpt-4.1-mini", name: "gpt-4.1-mini" }],
      availableModels: [{ id: "gpt-4.1-mini", name: "gpt-4.1-mini" }]
    });
    updateProvider(db, "anthropic", {
      enabled: true,
      apiKey: "anthropic-key",
      models: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }],
      availableModels: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }]
    });
    setModel(config, "chat", "openai:gpt-4.1-mini");

    const resolved = resolveModelSlot(db, config, "chat", "anthropic:claude-sonnet-4-6");

    expect(resolved).toMatchObject({
      ok: true,
      binding: { providerId: "anthropic", modelId: "claude-sonnet-4-6", apiKey: "anthropic-key" }
    });
  });

  it("暴露模型能力限制(contextWindow/maxOutputTokens)", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });
    updateProvider(db, "openai", {
      enabled: true,
      apiKey: "openai-key",
      models: [{
        id: "gpt-4.1-mini",
        name: "gpt-4.1-mini",
        capabilities: { contextWindow: 256_000, maxOutputTokens: 16_000 }
      }],
      availableModels: [{
        id: "gpt-4.1-mini",
        name: "gpt-4.1-mini",
        capabilities: { contextWindow: 256_000, maxOutputTokens: 16_000 }
      }]
    });
    setModel(config, "chat", "openai:gpt-4.1-mini");

    // chat 槽位无全局默认兜底:override 是唯一来源。
    const resolved = resolveModelSlot(db, config, "chat", "openai:gpt-4.1-mini");

    expect(resolved).toMatchObject({
      ok: true,
      binding: { contextWindow: 256_000, maxOutputTokens: 16_000 }
    });
  });

  it("chat 槽位不回落 settings —— 无 override 即 ok:false(模型是 per-run 选的)", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });
    updateProvider(db, "openai", {
      enabled: true,
      apiKey: "openai-key",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
      availableModels: [{ id: "gpt-4o", name: "GPT-4o" }]
    });
    setModel(config, "chat", "openai:gpt-4o");

    // settings 配了 chat,但 chat 槽位不读 settings —— 没 override 就是没选模型。
    const resolved = resolveModelSlot(db, config, "chat");
    expect(resolved).toMatchObject({ ok: false });
  });

  it("chat 未配置 → ok:false 且 reason 可读", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });
    const current = loadAppSettings(db, config);
    replaceAppSettings(db, config, { ...current, models: { chat: "" } });

    const resolved = resolveModelSlot(db, config, "chat");
    expect(resolved).toMatchObject({ ok: false });
  });

  it("provider 未启用 → ok:false", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });
    // 默认 seed 的 provider 都是 disabled
    setModel(config, "chat", "openai:gpt-4.1-mini");
    const resolved = resolveModelSlot(db, config, "chat");
    expect(resolved).toMatchObject({ ok: false });
  });

  it("provider 无 key → ok:false", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });
    updateProvider(db, "openai", {
      enabled: true,
      models: [{ id: "gpt-4.1-mini", name: "gpt-4.1-mini" }],
      availableModels: [{ id: "gpt-4.1-mini", name: "gpt-4.1-mini" }]
    });
    setModel(config, "chat", "openai:gpt-4.1-mini");
    const resolved = resolveModelSlot(db, config, "chat");
    expect(resolved).toMatchObject({ ok: false });
  });

  it("模型标识不含冒号 → ok:false(不再前缀猜测)", () => {
    const config = loadConfig({ env: {}, cwd: "/tmp" });
    const resolved = resolveModelSlot(db, config, "chat", "gpt-4o");
    expect(resolved).toMatchObject({
      ok: false,
      reason: "模型标识必须是 providerId:modelId 形式：gpt-4o"
    });
  });
});
