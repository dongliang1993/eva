import type {
  AgentObserver,
  PromptSection,
  Skill
} from "@eva/harness";

import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type {
  AgentFactory,
  RunLedger,
  RunRegistry,
} from "../modules/runs/index.js";
import type { Encryptor } from "../infrastructure/crypto/encryptor.js";
import type { McpRegistry } from "../modules/mcp/index.js";
import type { ApprovalGateway } from "../modules/approvals/index.js";
import type { ApprovalPolicyStore } from "../modules/approvals/index.js";
import type { PlanWeaveService } from "../modules/plan-weave/index.js";
import type { SessionService } from "../modules/sessions/index.js";
import type { WorkspaceStore } from "../modules/workspaces/index.js";
import type { AppApi } from "../api/index.js";

export interface AppInfrastructure {
  config: AppConfig;
  db: AppDatabase;
  /** 进程级 logger。装配期就需要它（MCP 连接、配置同步都要留痕）。 */
  logger: Logger;
  skills: readonly Skill[];
  /** apiKey 落库加解密(provider repository 的唯一进出边界)。 */
  encryptor: Encryptor;
  observer?: AgentObserver | undefined;
  soulSection?: PromptSection | undefined;
}

export interface AppServices {
  agents: AgentFactory;
  session: SessionService;
  approvals: ApprovalGateway;
  approvalPolicies: ApprovalPolicyStore;
  runLedger: RunLedger;
  runRegistry: RunRegistry;
  workspaces: WorkspaceStore;
  planWeave: PlanWeaveService;
  mcp: McpRegistry;
}

declare module "fastify" {
  interface FastifyInstance {
    infra: AppInfrastructure;
    services: AppServices;
    /**
     * Route 唯一该用的那个 —— 按业务能力分组的用例入口(见 src/api/README.md)。
     *
     * `infra` 与 `services` 仍然挂在实例上,因为组合根、coordinator 和尚未搬完的
     * route 还要用。Wave 2 结束时 route 侧只应出现 `app.api`。
     */
    api: AppApi;
  }
}
