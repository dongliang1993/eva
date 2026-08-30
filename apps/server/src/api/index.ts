import type { AppInfrastructure, AppServices } from "../types/common.js";
import { UsageRecordRepository } from "../db/repositories/usage-record-repository.js";
import { createProvidersApi, type ProvidersApi } from "./providers-api.js";
import { createSettingsApi, type SettingsApi } from "./settings-api.js";
import { createUsageApi, type UsageApi } from "./usage-api.js";

/**
 * Route 能看到的全部东西 —— 按业务能力分组,一个能力一个入口。
 *
 * 这里**不暴露** `db`、`encryptor` 或任何 Repository。想给 route 加一个查询,
 * 就在对应的 `*-api.ts` 里加一个方法;不要把 db 递过去(宪法 C2,宪章 §10.2 第 1、3 条)。
 *
 * 逐个能力搬进来,按「违规量从小到大」—— 便宜的 route 先把这一层的形状试出来,
 * 再动 threads.ts 时就不用返工(§12 Wave 2)。还没搬完的能力暂时不在这个类型里。
 */
export interface AppApi {
  readonly providers: ProvidersApi;
  readonly settings: SettingsApi;
  readonly usage: UsageApi;
}

/**
 * 组合根的第二半 —— **唯一 `new` Repository 的地方**(§10.2 第 3 条)。
 *
 * `buildAppServices` 建的是有状态的长寿服务(AgentFactory 的缓存、RunRegistry 的在飞表);
 * 这里建的是无状态的用例入口。分成两个函数是因为后者依赖前者。
 */
export const buildAppApi = (infra: AppInfrastructure, services: AppServices): AppApi => ({
  providers: createProvidersApi({
    db: infra.db,
    encryptor: infra.encryptor,
    agents: services.agents
  }),
  settings: createSettingsApi({
    db: infra.db,
    config: infra.config,
    agents: services.agents
  }),
  usage: createUsageApi({
    usageRecords: new UsageRecordRepository(infra.db)
  })
});
