import type { AppSettings } from "@eva/shared";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import { loadAppSettings, replaceAppSettings } from "./app-settings.js";

interface AgentCacheInvalidator {
  invalidate(): void;
}

export interface SettingsApi {
  read(): AppSettings;
  /** 整份替换。写完必须让 AgentFactory 失效 —— 否则改了工具模型这轮还用旧的。 */
  replace(next: AppSettings): AppSettings;
}

export const createSettingsApi = (deps: {
  readonly db: AppDatabase;
  readonly config: AppConfig;
  readonly agents: AgentCacheInvalidator;
}): SettingsApi => ({
  read: () => loadAppSettings(deps.db, deps.config),
  replace: (next) => {
    const updated = replaceAppSettings(deps.db, deps.config, next);
    // 缓存失效属于「改设置」这个用例的一部分,不是调用方的礼节 ——
    // 放在 route 里,下一个写设置的入口就会忘。
    deps.agents.invalidate();
    return updated;
  }
});
