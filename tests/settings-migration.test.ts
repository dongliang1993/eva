import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import { loadAppSettings } from "../apps/server/src/services/settings/app-settings.js";
import { migrateLegacySettings } from "../apps/server/src/services/settings/migrate-legacy.js";

let db: AppDatabase;

type WarnLogger = { info: (object: unknown, message?: string) => void };
const silentLogger: WarnLogger = { info: () => {} };

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