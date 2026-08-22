import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import { loadAppSettings } from "../apps/server/src/services/settings/app-settings.js";
import {
  migrateAlwaysAllowToolsToPolicies,
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

/** 读 settings 里 security 块的原始 JSON(T31 后 loadAppSettings 已不再带 alwaysAllowTools)。 */
const rawSecurity = (): Record<string, unknown> => {
  const row = rawClient().prepare("SELECT value FROM settings WHERE key = 'security'").get() as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : {};
};

describe("migrateLegacySettings", () => {
  it("旧字段 → tool/embedding 槽位对得上,chat.defaultModel 不再进 models", () => {
    writeLegacyBlock("chat", { defaultModel: "openai:gpt-4o", temperature: 0.5, autoCompact: true });
    writeLegacyBlock("toolModel", { model: "openai:gpt-4.1-mini" });
    writeLegacyBlock("memory", { enabled: true, embedding: {} });

    migrateLegacySettings(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    // 主对话模型已是 per-run 决策(请求的 modelId / sessions.model),没有全局槽位。
    expect((migrated.models as Record<string, string>).chat).toBeUndefined();
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

    // T31:alwaysAllowTools 已从 AppSettings 退役,读原始行断言(T14 迁移仍写它,供 T27 接力)。
    expect(rawSecurity().alwaysAllowTools).toEqual(["bash", "write", "edit"]);
    // 旧开关不再出现在持久化结构里
    const securityRow = rawClient()
      .prepare("SELECT * FROM settings WHERE key = 'security'")
      .get() as { value: string } | undefined;
    expect(JSON.stringify(securityRow?.value)).not.toContain("autoApproveToolRequests");
  });

  it("旧为 false → 空数组", () => {
    writeLegacyBlock("security", { logLevel: "info", autoApproveToolRequests: false });

    migrateSecurityToAlwaysAllowTools(db, silentLogger);

    expect(rawSecurity().alwaysAllowTools).toEqual([]);
  });

  it("幂等:已含 alwaysAllowTools 则不动(即使旧开关还在)", () => {
    // 模拟已迁过的状态:有 alwaysAllowTools 字段 + 残留 autoApproveToolRequests
    writeLegacyBlock("security", {
      logLevel: "info",
      alwaysAllowTools: ["write"],
      autoApproveToolRequests: true
    });

    migrateSecurityToAlwaysAllowTools(db, silentLogger);

    // 幂等:保持原来白名单,不被旧 true 覆盖成三个工具
    expect(rawSecurity().alwaysAllowTools).toEqual(["write"]);
  });

  it("无 security 块 → 不崩", () => {
    migrateSecurityToAlwaysAllowTools(db, silentLogger);
    expect(rawSecurity().alwaysAllowTools).toBeUndefined();
  });
});

describe("migrateAlwaysAllowToolsToPolicies (T27)", () => {
  it("旧白名单 bash/write → thread:global 条目,且旧字段清空", () => {
    writeLegacyBlock("security", { logLevel: "info", alwaysAllowTools: ["bash", "write"] });

    migrateAlwaysAllowToolsToPolicies(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    expect(migrated.security.allowAlwaysPolicies).toEqual(
      expect.arrayContaining(["bash:thread:global:all", "write:thread:global:all"])
    );
    // T31 迁完即净:旧字段不再残留(不是清空,是连键都不留)。
    expect("alwaysAllowTools" in rawSecurity()).toBe(false);
  });

  it("mcp 旧条目折成整域 mcp:thread:global:all(不逐工具展开)", () => {
    writeLegacyBlock("security", { logLevel: "info", alwaysAllowTools: ["mcp__github__x"] });

    migrateAlwaysAllowToolsToPolicies(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    expect(migrated.security.allowAlwaysPolicies).toEqual(["mcp:thread:global:all"]);
  });

  it("幂等:已含 allowAlwaysPolicies 字段则不动(哪怕空数组)", () => {
    writeLegacyBlock("security", {
      logLevel: "info",
      alwaysAllowTools: ["bash"],
      allowAlwaysPolicies: ["bash:thread:t1:command:npm test"]
    });

    migrateAlwaysAllowToolsToPolicies(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    // 不动既有 policies,也不清空 alwaysAllowTools(幂等 = 整体跳过)
    expect(migrated.security.allowAlwaysPolicies).toEqual(["bash:thread:t1:command:npm test"]);
  });

  it("含无法识别条目 → 跳过该条、其余照迁", () => {
    writeLegacyBlock("security", {
      logLevel: "info",
      alwaysAllowTools: ["bash", "unknown_thing", "edit"]
    });

    migrateAlwaysAllowToolsToPolicies(db, silentLogger);

    const migrated = loadAppSettings(db, config);
    expect(migrated.security.allowAlwaysPolicies).toEqual(
      expect.arrayContaining(["bash:thread:global:all", "edit:thread:global:all"])
    );
    // 无法识别的不臆造
    expect(migrated.security.allowAlwaysPolicies.some((k) => k.includes("unknown_thing"))).toBe(false);
  });

  it("无 security 块 → 不崩,默认空", () => {
    migrateAlwaysAllowToolsToPolicies(db, silentLogger);
    const migrated = loadAppSettings(db, config);
    expect(migrated.security.allowAlwaysPolicies).toEqual([]);
  });
});