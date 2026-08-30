import type { AppInfrastructure, AppServices } from "../types/common.js";
import { BackgroundTaskRepository } from "../db/repositories/background-task-repository.js";
import { DrizzleMemoryRepository } from "../db/repositories/memory-repository.js";
import { DrizzleMessageRepository } from "../db/repositories/message-repository.js";
import { DrizzleMessageSearchRepository } from "../db/repositories/message-search-repository.js";
import { RunEventRepository } from "../db/repositories/run-event-repository.js";
import { DrizzleRunRepository } from "../db/repositories/run-repository.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { McpServerRepository } from "../db/repositories/mcp-server-repository.js";
import { UsageRecordRepository } from "../db/repositories/usage-record-repository.js";
import { createApprovalsApi, type ApprovalsApi } from "./approvals-api.js";
import { createMcpApi, type McpApi } from "./mcp-api.js";
import { createMemoryApi, type MemoryApi } from "./memory-api.js";
import { createObservabilityApi, type ObservabilityApi } from "./observability-api.js";
import { createPlansApi, type PlansApi } from "./plans-api.js";
import { createProvidersApi, type ProvidersApi } from "./providers-api.js";
import { createRunsApi, type RunsApi } from "./runs-api.js";
import { createSearchApi, type SearchApi } from "./search-api.js";
import { createSessionsApi, type SessionsApi } from "./sessions-api.js";
import { createSettingsApi, type SettingsApi } from "./settings-api.js";
import { createSkillsApi, type SkillsApi } from "./skills-api.js";
import { createUsageApi, type UsageApi } from "./usage-api.js";
import { createWorkspacesApi, type WorkspacesApi } from "./workspaces-api.js";

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
  readonly approvals: ApprovalsApi;
  readonly mcp: McpApi;
  readonly memory: MemoryApi;
  readonly observability: ObservabilityApi;
  readonly plans: PlansApi;
  readonly providers: ProvidersApi;
  readonly runs: RunsApi;
  readonly search: SearchApi;
  readonly sessions: SessionsApi;
  readonly settings: SettingsApi;
  readonly skills: SkillsApi;
  readonly usage: UsageApi;
  readonly workspaces: WorkspacesApi;
}

/**
 * 组合根的第二半 —— **唯一 `new` Repository 的地方**(§10.2 第 3 条)。
 *
 * `buildAppServices` 建的是有状态的长寿服务(AgentFactory 的缓存、RunRegistry 的在飞表);
 * 这里建的是无状态的用例入口。分成两个函数是因为后者依赖前者。
 */
export const buildAppApi = (infra: AppInfrastructure, services: AppServices): AppApi => ({
  approvals: createApprovalsApi({
    approvals: services.approvals,
    policies: services.approvalPolicies
  }),
  mcp: createMcpApi({
    servers: new McpServerRepository(infra.db),
    registry: services.mcp
  }),
  memory: createMemoryApi({
    db: infra.db,
    config: infra.config,
    memories: new DrizzleMemoryRepository(infra.db)
  }),
  observability: createObservabilityApi({
    runEvents: new RunEventRepository(infra.db),
    runs: new DrizzleRunRepository(infra.db)
  }),
  plans: createPlansApi({ planWeave: services.planWeave }),
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
  runs: createRunsApi(infra, services),
  search: createSearchApi({
    db: infra.db,
    messageSearch: new DrizzleMessageSearchRepository(infra.db)
  }),
  sessions: createSessionsApi({
    db: infra.db,
    config: infra.config,
    logger: infra.logger,
    sessions: new DrizzleSessionRepository(infra.db),
    messages: new DrizzleMessageRepository(infra.db),
    runs: new DrizzleRunRepository(infra.db),
    backgroundTasks: new BackgroundTaskRepository(infra.db),
    approvals: services.approvals,
    session: services.session
  }),
  skills: createSkillsApi({ skills: infra.skills }),
  usage: createUsageApi({
    usageRecords: new UsageRecordRepository(infra.db)
  }),
  workspaces: createWorkspacesApi({ workspaces: services.workspaces })
});
