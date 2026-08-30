import { ApprovalRepository } from "../modules/approvals/index.js";
import { DrizzleSessionRepository } from "../modules/sessions/index.js";
import { DrizzleMessageRepository } from "../modules/sessions/index.js";
import {
  AgentFactory,
  DrizzleRunRepository,
  RunLedger,
  RunRegistry,
} from "../modules/runs/index.js";
import { McpRegistry, McpServerRepository } from "../modules/mcp/index.js";
import type { AppInfrastructure, AppServices } from "../types/common.js";
import {
  ApprovalGateway,
  ApprovalPolicyStore,
} from "../modules/approvals/index.js";
import { PlanWeaveService } from "../modules/plan-weave/index.js";
import { SessionService } from "../modules/sessions/index.js";
import {
  DrizzleWorkspaceRepository,
  WorkspaceStore,
} from "../modules/workspaces/index.js";

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
    runLedger: new RunLedger(new DrizzleRunRepository(infra.db)),
    runRegistry: new RunRegistry(),
    workspaces,
    // T46:任务图状态在 workspace 文件里,service 只认 workspaceId —— 无 DB 表。
    planWeave: new PlanWeaveService(workspaces),
    mcp: new McpRegistry(new McpServerRepository(infra.db), infra.logger)
  };
};
