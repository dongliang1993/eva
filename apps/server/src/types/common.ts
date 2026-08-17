import type {
  AgentObserver,
  PromptSection,
  Skill
} from "@eva/harness";

import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { ApprovalGateway } from "../services/approval-gateway.js";
import type { RunRegistry } from "../services/run-registry.js";
import type { RunApiService } from "../services/runs.js";
import type { SessionService } from "../services/session.js";

export interface AppInfrastructure {
  config: AppConfig;
  db: AppDatabase;
  skills: readonly Skill[];
  observer?: AgentObserver | undefined;
  soulSection?: PromptSection | undefined;
}

export interface AppServices {
  runs: RunApiService;
  session: SessionService;
  approvals: ApprovalGateway;
  runRegistry: RunRegistry;
}

declare module "fastify" {
  interface FastifyInstance {
    infra: AppInfrastructure;
    services: AppServices;
  }
}
