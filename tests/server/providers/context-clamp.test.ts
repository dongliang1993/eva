import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import {
  findStoredProviderById,
  updateProvider
} from "../../../apps/server/src/services/providers/provider-repository.js";
import {
  clampContextWindow,
  computeClampedContextWindow,
  MIN_CONTEXT_WINDOW
} from "../../../apps/server/src/services/providers/context-clamp.js";

let db: AppDatabase;

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  // 造一个 contextWindow 虚高(128k)的 provider,modelId = qwen3
  updateProvider(db, "openai", {
    enabled: true,
    apiKey: "k",
    baseURL: "https://db.example/v1",
    models: [
      { id: "qwen3", name: "Qwen3", capabilities: { contextWindow: 128_000 } }
    ],
    availableModels: [
      { id: "qwen3", name: "Qwen3", capabilities: { contextWindow: 128_000 } }
    ]
  });
});

afterEach(() => {
  closeDb(db);
});

const readContextWindow = (): number | undefined =>
  findStoredProviderById(db, "openai")?.models?.find((m) => m.id === "qwen3")
    ?.capabilities?.contextWindow;

describe("computeClampedContextWindow(T38)", () => {
  it("钳到 observed 的 90%", () => {
    expect(computeClampedContextWindow(100_000)).toBe(90_000);
  });

  it("低于下限 → 兜到 MIN_CONTEXT_WINDOW", () => {
    expect(computeClampedContextWindow(5_000)).toBe(MIN_CONTEXT_WINDOW);
  });
});

describe("clampContextWindow(T38 钳制学习)", () => {
  it("真实超限 → contextWindow 永久钳小写 DB(重启后可读)", () => {
    const r = clampContextWindow(db, {
      providerId: "openai",
      modelId: "qwen3",
      observedTokens: 100_000
    });
    expect(r.clamped).toBe(true);
    expect(r.oldContextWindow).toBe(128_000);
    expect(r.newContextWindow).toBe(90_000);
    // 持久化:重新读 DB 是钳小值
    expect(readContextWindow()).toBe(90_000);
  });

  it("availableModels 同步钳小(model-resolver 查找顺序 models→availableModels)", () => {
    clampContextWindow(db, {
      providerId: "openai",
      modelId: "qwen3",
      observedTokens: 100_000
    });
    const avail = findStoredProviderById(db, "openai")?.availableModels?.find(
      (m) => m.id === "qwen3"
    )?.capabilities?.contextWindow;
    expect(avail).toBe(90_000);
  });

  it("幂等:再次以更大 observed 调用不越钳越大", () => {
    clampContextWindow(db, { providerId: "openai", modelId: "qwen3", observedTokens: 100_000 }); // → 90k
    const r = clampContextWindow(db, { providerId: "openai", modelId: "qwen3", observedTokens: 120_000 }); // 120k×0.9=108k > 90k
    expect(r.clamped).toBe(false);
    expect(readContextWindow()).toBe(90_000); // 不变
  });

  it("下限:observed 极小 → 钳到 8k 不再低", () => {
    const r = clampContextWindow(db, {
      providerId: "openai",
      modelId: "qwen3",
      observedTokens: 5_000
    });
    expect(r.newContextWindow).toBe(MIN_CONTEXT_WINDOW);
    expect(readContextWindow()).toBe(MIN_CONTEXT_WINDOW);
  });

  it("modelId 不在 provider → 不写不崩", () => {
    const r = clampContextWindow(db, {
      providerId: "openai",
      modelId: "nonexistent",
      observedTokens: 100_000
    });
    expect(r.clamped).toBe(false);
  });

  it("模型没登记 contextWindow(缺省)→ 不钳(缺省由 policy 兜)", () => {
    updateProvider(db, "openai", {
      models: [{ id: "qwen3", name: "Qwen3" }], // 无 capabilities
      availableModels: [{ id: "qwen3", name: "Qwen3" }]
    });
    const r = clampContextWindow(db, {
      providerId: "openai",
      modelId: "qwen3",
      observedTokens: 100_000
    });
    expect(r.clamped).toBe(false);
  });

  it("providerId 不存在 → 不写不崩", () => {
    const r = clampContextWindow(db, {
      providerId: "no-such-provider",
      modelId: "qwen3",
      observedTokens: 100_000
    });
    expect(r.clamped).toBe(false);
  });
});
