import type {
  ModelSummary,
  Provider,
  ProviderConnectionTestResult,
  ProviderModelsPayload,
  ProviderSpec
} from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import type { Encryptor } from "../../infrastructure/crypto/encryptor.js";
import { PROVIDER_CATALOG } from "./provider-catalog.js";
import {
  discoverProviderModels,
  listProviderModels,
  testProviderConnection,
  type ProviderHttpOverrides
} from "./provider-http.js";
import {
  createProvider,
  deleteProvider,
  findProviderById,
  findStoredProviderById,
  listProviders,
  updateProvider,
  type ProviderCreateInput,
  type ProviderUpdateInput
} from "./provider-repository.js";
import { qualifyProviderModelId } from "../settings/index.js";

interface AgentCacheInvalidator {
  invalidate(): void;
}

export interface ProvidersApi {
  list(): readonly Provider[];
  /** provider 静态知识(不含密钥)。 */
  catalog(): readonly ProviderSpec[];
  /** 所有 enabled provider 的模型目录,产出 qualified id(供 UI 选择器)。 */
  listModelSummaries(): readonly ModelSummary[];
  exists(id: string): boolean;
  create(input: ProviderCreateInput): Provider;
  update(id: string, input: ProviderUpdateInput): Provider | undefined;
  delete(id: string): boolean;
  /**
   * 揭示已存 API key 明文。刻意做成独立用例 —— 列表/详情只带 hasApiKey,
   * 明文不随常规数据流离开服务端(坑 2 的收窄版:从「永不离开」收窄为
   * 「仅经这个显式入口单次返回」)。provider 不存在时返回 undefined。
   */
  revealApiKey(id: string): string | undefined;
  testConnection(
    id: string,
    override: ProviderHttpOverrides
  ): Promise<ProviderConnectionTestResult | undefined>;
  listModels(id: string): ProviderModelsPayload | undefined;
  /** 拉一次上游模型列表并写回 availableModels。 */
  discoverModels(
    id: string,
    override: ProviderHttpOverrides
  ): Promise<ProviderModelsPayload | undefined>;
}

export const createProvidersApi = (deps: {
  readonly db: AppDatabase;
  readonly encryptor: Encryptor;
  readonly agents: AgentCacheInvalidator;
}): ProvidersApi => {
  /**
   * 每一次 provider 写入之后都必须让 AgentFactory 失效 —— 它缓存了按
   * (provider, model) 绑定的 LanguageModel 实例。收在这里而不是各个 route:
   * 之前是 7 个 handler 各自记得调一次,漏一个的表现是「改了 key 但这轮还用旧的」。
   */
  const invalidated = <T>(value: T): T => {
    deps.agents.invalidate();
    return value;
  };

  return {
    list: () => listProviders(deps.db),
    catalog: () => PROVIDER_CATALOG,

    listModelSummaries: () =>
      listProviders(deps.db)
        .filter((provider) => provider.enabled)
        .flatMap((provider) =>
          provider.models.map((model) => ({
            id: qualifyProviderModelId(provider.id, model.id),
            name: model.name,
            provider: provider.name,
            providerId: provider.id,
            ...(model.capabilities !== undefined ? { capabilities: model.capabilities } : {})
          }))
        ),

    exists: (id) => findProviderById(deps.db, id) !== undefined,

    create: (input) => invalidated(createProvider(deps.db, input, deps.encryptor)),

    update: (id, input) => {
      const updated = updateProvider(deps.db, id, input, deps.encryptor);
      return updated ? invalidated(updated) : undefined;
    },

    delete: (id) => {
      const deleted = deleteProvider(deps.db, id);
      return deleted ? invalidated(deleted) : false;
    },

    revealApiKey: (id) => findStoredProviderById(deps.db, id, deps.encryptor)?.apiKey,

    testConnection: async (id, override) => {
      const provider = findStoredProviderById(deps.db, id, deps.encryptor);
      if (!provider) return undefined;
      return testProviderConnection(provider, override);
    },

    listModels: (id) => {
      const provider = findStoredProviderById(deps.db, id, deps.encryptor);
      if (!provider) return undefined;
      return listProviderModels(provider);
    },

    discoverModels: async (id, override) => {
      const provider = findStoredProviderById(deps.db, id, deps.encryptor);
      if (!provider) return undefined;

      const discovered = await discoverProviderModels(provider, override);
      // 拉到就写回:下次开设置页不必再等一次网络往返。
      updateProvider(deps.db, id, { availableModels: discovered.models });
      return invalidated(discovered);
    }
  };
};
