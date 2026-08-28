import type { AppSettings } from "@eva/shared";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import { settings } from "../../db/schema.js";

const SETTINGS_BLOCK_KEYS = ["models", "chat", "memory", "security", "observability"] as const;

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

/** 默认值。models 全为空 —— 主对话模型 per-run 选,tool/embedding 未配即降级。 */
const createDefaultSettings = (): AppSettings => ({
  models: {},
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
    allowAlwaysPolicies: []
  },
  observability: {
    enabled: true,
    captureContent: "redacted",
    retentionDays: 30,
    maxDatabaseBytes: 1_073_741_824
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
        // 刻意不读 parsed.chat:老库里可能还留着 R2 迁移写进去的值,但主对话模型
        // 已改成 per-run 决策(请求的 modelId / sessions.model)。读回来就会多出
        // 一个过期的事实源 —— 用户在 UI 换了模型,这里还是旧值。
        current.models = {
          ...current.models,
          ...(typeof parsed.tool === "string" ? { tool: parsed.tool } : {}),
          ...(typeof parsed.embedding === "string" ? { embedding: parsed.embedding } : {})
        };
      } else if (key === "chat") {
        current.chat = { ...current.chat, ...parsed } as AppSettings["chat"];
      } else if (key === "memory") {
        current.memory = { ...current.memory, ...parsed } as AppSettings["memory"];
      } else if (key === "security") {
        current.security = { ...current.security, ...parsed } as AppSettings["security"];
      } else if (key === "observability") {
        current.observability = { ...current.observability, ...parsed } as AppSettings["observability"];
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
  // 无 UI 的块(如 observability)允许调用方不传 —— 传什么写什么会把它们重置成默认值,
  // 保留现值才是"没让改"。
  const current = loadAppSettings(db, config);

  db.delete(settings).run();

  for (const key of SETTINGS_BLOCK_KEYS) {
    db.insert(settings).values({
      key,
      value: JSON.stringify(next[key] ?? current[key])
    }).run();
  }

  return loadAppSettings(db, config);
};