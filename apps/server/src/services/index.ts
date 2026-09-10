import { ApprovalRepository } from "../modules/approvals/index.js";
import { DrizzleSessionRepository } from "../modules/sessions/index.js";
import { DrizzleMessageRepository } from "../modules/sessions/index.js";
import {
  AgentFactory,
  DrizzleRunRepository,
  RunRegistry,
} from "../modules/runs/index.js";
import { McpRegistry, McpServerRepository } from "../modules/mcp/index.js";
import type { AppInfrastructure, AppServices } from "../types/common.js";
import {
  ApprovalGateway,
  ApprovalPolicyStore,
} from "../modules/approvals/index.js";
import { SessionService } from "../modules/sessions/index.js";
import {
  DrizzleWorkspaceRepository,
  WorkspaceStore,
} from "../modules/workspaces/index.js";
import { MemoryAutomationService } from "../modules/memory/index.js";

export const buildAppServices = (infra: AppInfrastructure): AppServices => {
  const workspaces = new WorkspaceStore(new DrizzleWorkspaceRepository(infra.db));

  return {
    agents: new AgentFactory(infra),
    session: new SessionService(
      new DrizzleSessionRepository(infra.db),
      new DrizzleMessageRepository(infra.db)
    ),
    approvals: new ApprovalGateway(new ApprovalRepository(infra.db)),
    approvalPolicies: new ApprovalPolicyStore(infra.db, infra.config),
    runRegistry: new RunRegistry(),
    workspaces,
    memoryAutomation: new MemoryAutomationService({
      db: infra.db,
      config: infra.config,
      encryptor: infra.encryptor,
      logger: infra.logger
    }),
    // T46:任务图状态在 workspace 文件里,service 只认 workspaceId —— 无 DB 表。
    mcp: new McpRegistry(new McpServerRepository(infra.db), infra.logger)
  };
};
