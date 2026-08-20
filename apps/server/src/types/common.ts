import type {
  AgentObserver,
  PromptSection,
  Skill
} from "@eva/harness";

import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { AgentFactory } from "../services/agent-factory.js";
import type { Encryptor } from "../services/crypto/encryptor.js";
import type { McpRegistry } from "../services/mcp/mcp-registry.js";
import type { ApprovalGateway } from "../services/approval-gateway.js";
import type { RunRegistry } from "../services/run-registry.js";
import type { RunLedger } from "../services/runs/run-ledger.js";
import type { SessionService } from "../services/session.js";
import type { WorkspaceStore } from "../services/workspaces/workspace-store.js";

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
  runLedger: RunLedger;
  runRegistry: RunRegistry;
  workspaces: WorkspaceStore;
  mcp: McpRegistry;
}

declare module "fastify" {
  interface FastifyInstance {
    infra: AppInfrastructure;
    services: AppServices;
  }
}
