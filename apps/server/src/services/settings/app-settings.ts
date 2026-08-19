import type { AppSettings } from "@eva/shared";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import { settings } from "../../db/schema.js";

const SETTINGS_BLOCK_KEYS = ["models", "chat", "memory", "security"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeLogLevel = (
  value: string
): AppSettings["security"]["logLevel"] => {
  switch (value) {
    case "error":
    case "fatal":
    case "silent":
      return "error";
    case "warn":
      return "warn";
    case "debug":
    case "trace":
      return "debug";
    default:
      return "info";
  }
};

/** 默认值。chat 槽位给一个指向 seed provider 的 id。 */
const createDefaultSettings = (): AppSettings => ({
  models: {
    chat: "openai:gpt-4.1-mini"
  },
  chat: {
    temperature: 0.1,
    autoCompact: true,
    autoCompactTokenThreshold: 80_000,
    autoCompactMessageThreshold: 30
  },
  memory: {
    enabled: true,
    autoSummarize: false,
    autoRetrieve: true,
    queryRewriting: false,
    maxRetrievedMemories: 5,
    similarityThreshold: 0.4
  },
  security: {
    logLevel: "info",
    alwaysAllowTools: []
  }
});

const parseJsonValue = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/** 读 settings,块合并规则"某块存在则覆盖该块(container 语义)"。 */
export const loadAppSettings = (
  db: AppDatabase,
  config: AppConfig
): AppSettings => {
  const defaults = createDefaultSettings();
  const current: AppSettings = {
    ...defaults,
    security: {
      ...defaults.security,
      logLevel: normalizeLogLevel(config.LOG_LEVEL)
    }
  };

  const rows = db.select().from(settings).all();

  for (const row of rows) {
    const key = row.key;

    if ((SETTINGS_BLOCK_KEYS as readonly string[]).includes(key)) {
      const parsed = parseJsonValue(row.value);
      if (!isRecord(parsed)) continue;

      if (key === "models") {
        current.models = {
          ...current.models,
          ...(typeof parsed.chat === "string" ? { chat: parsed.chat } : {}),
          ...(typeof parsed.tool === "string" ? { tool: parsed.tool } : {}),
          ...(typeof parsed.embedding === "string" ? { embedding: parsed.embedding } : {})
        };
      } else if (key === "chat") {
        current.chat = { ...current.chat, ...parsed } as AppSettings["chat"];
      } else if (key === "memory") {
        current.memory = { ...current.memory, ...parsed } as AppSettings["memory"];
      } else if (key === "security") {
        current.security = { ...current.security, ...parsed } as AppSettings["security"];
      }
      continue;
    }

    if (row.key === "log_level") {
      current.security.logLevel = normalizeLogLevel(row.value);
    }
  }

  return current;
};

export const replaceAppSettings = (
  db: AppDatabase,
  config: AppConfig,
  next: AppSettings
): AppSettings => {
  db.delete(settings).run();

  for (const key of SETTINGS_BLOCK_KEYS) {
    db.insert(settings).values({
      key,
      value: JSON.stringify(next[key])
    }).run();
  }

  return loadAppSettings(db, config);
};