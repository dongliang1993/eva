import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import { loadAppSettings } from "../apps/server/src/services/settings/app-settings.js";
import {
  migrateLegacySettings,
  migrateSecurityToAlwaysAllowTools
} from "../apps/server/src/services/settings/migrate-legacy.js";

let db: AppDatabase;

type WarnLogger = {
  info: (object: unknown, message?: string) => void;
  warn: (object: unknown, message?: string) => void;
};
const silentLogger: WarnLogger = { info: () => {}, warn: () => {} };

const rawClient = (): import("better-sqlite3").Database =>
  (db as unknown as { $client: import("better-sqlite3").Database }).$client;

const writeLegacyBlock = (key: string, value: unknown): void => {
  rawClient().prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
};

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
});

afterEach(() => {
  closeDb(db);
});

const config = { LOG_LEVEL: "info", PORT: 8082, HOST: "127.0.0.1", DB_PATH: "" } as never;

describe("migrateLegacySettings", () => {
  it("旧四字段 → models 三个槽位对得上", () => {
    writeLegacyBlock("chat", { defaultModel: "openai:gpt-4o", temperature: 0.5, autoCompact: true });
    writeLegacyBlock("toolModel", { model: "openai:gpt-4.1-mini" });
    writeLegacyBlock("memory", { enabled: true, embedding: {} });

    migrateLegacySettings(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    expect(migrated.models.chat).toBe("openai:gpt-4o");
    expect(migrated.models.tool).toBe("openai:gpt-4.1-mini");
    expect(migrated.models.embedding).toBeUndefined();
  });

  it("memory.embedding 齐全 → providers 多一条且 models.embedding 指向它", () => {
    writeLegacyBlock("chat", { defaultModel: "openai:gpt-4o" });
    writeLegacyBlock("memory", {
      embedding: {
        baseUrl: "https://emb.example/v1",
        apiKey: "emb-key",
        model: "text-embedding-3-small"
      }
    });

    migrateLegacySettings(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    expect(migrated.models.embedding).toBe("embedding-migrated:text-embedding-3-small");

    const providerRow = rawClient()
      .prepare("SELECT * FROM providers WHERE id = ?")
      .get("embedding-migrated") as { api_key: string } | undefined;
    expect(providerRow).toBeDefined();
    expect(providerRow?.api_key).toBe("emb-key");
  });

  it("memory.embedding 不全 → 不建 provider,embedding 为 undefined", () => {
    writeLegacyBlock("chat", { defaultModel: "openai:gpt-4o" });
    writeLegacyBlock("memory", { embedding: { baseUrl: "https://emb.example/v1" } });

    migrateLegacySettings(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    expect(migrated.models.embedding).toBeUndefined();

    const providerRow = rawClient()
      .prepare("SELECT * FROM providers WHERE id = ?")
      .get("embedding-migrated");
    expect(providerRow).toBeUndefined();
  });

  it("幂等:连跑两次不重复建 provider、结果一致", () => {
    writeLegacyBlock("chat", { defaultModel: "openai:gpt-4o" });
    writeLegacyBlock("memory", {
      embedding: { baseUrl: "https://emb.example/v1", apiKey: "emb-key", model: "text-embedding-3-small" }
    });

    migrateLegacySettings(db, silentLogger);
    migrateLegacySettings(db, silentLogger);

    const matching = rawClient().prepare("SELECT * FROM providers WHERE id = ?").all("embedding-migrated");
    expect(matching).toHaveLength(1);

    const migrated = loadAppSettings(db, config);
    expect(migrated.models.embedding).toBe("embedding-migrated:text-embedding-3-small");
  });
});

describe("migrateSecurityToAlwaysAllowTools (T14)", () => {
  it("旧为 true → 白名单填 bash/write/edit,且旧开关字段被剔除", () => {
    writeLegacyBlock("security", { logLevel: "info", autoApproveToolRequests: true });

    migrateSecurityToAlwaysAllowTools(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    expect(migrated.security.alwaysAllowTools).toEqual(["bash", "write", "edit"]);
    // 旧开关不再出现在持久化结构里
    const securityRow = rawClient()
      .prepare("SELECT * FROM settings WHERE key = 'security'")
      .get() as { value: string } | undefined;
    expect(JSON.stringify(securityRow?.value)).not.toContain("autoApproveToolRequests");
  });

  it("旧为 false → 空数组", () => {
    writeLegacyBlock("security", { logLevel: "info", autoApproveToolRequests: false });

    migrateSecurityToAlwaysAllowTools(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    expect(migrated.security.alwaysAllowTools).toEqual([]);
  });

  it("幂等:已含 alwaysAllowTools 则不动(即使旧开关还在)", () => {
    // 模拟已迁过的状态:有 alwaysAllowTools 字段 + 残留 autoApproveToolRequests
    writeLegacyBlock("security", {
      logLevel: "info",
      alwaysAllowTools: ["write"],
      autoApproveToolRequests: true
    });

    migrateSecurityToAlwaysAllowTools(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    // 幂等:保持原来白名单,不被旧 true 覆盖成三个工具
    expect(migrated.security.alwaysAllowTools).toEqual(["write"]);
  });

  it("无 security 块 → 不崩", () => {
    migrateSecurityToAlwaysAllowTools(db, silentLogger);
    const migrated = loadAppSettings(db, config);
    expect(migrated.security.alwaysAllowTools).toEqual([]);
  });
});