import { ApprovalRepository } from "../db/repositories/approval-repository.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { DrizzleMessageRepository } from "../db/repositories/message-repository.js";
import { McpServerRepository } from "../db/repositories/mcp-server-repository.js";
import { DrizzleWorkspaceRepository } from "../db/repositories/workspace-repository.js";
import type { AppInfrastructure, AppServices } from "../types/common.js";
import { AgentFactory } from "./agent-factory.js";
import { ApprovalGateway } from "./approval-gateway.js";
import { McpRegistry } from "./mcp/mcp-registry.js";
import { RunRegistry } from "./run-registry.js";
import { SessionService } from "./session.js";
import { WorkspaceStore } from "./workspaces/workspace-store.js";

export const buildAppServices = (infra: AppInfrastructure): AppServices => ({
  agents: new AgentFactory(infra),
  session: new SessionService(
    new DrizzleSessionRepository(infra.db),
    new DrizzleMessageRepository(infra.db)
  ),
  approvals: new ApprovalGateway(new ApprovalRepository(infra.db)),
  runRegistry: new RunRegistry(),
  workspaces: new WorkspaceStore(new DrizzleWorkspaceRepository(infra.db)),
  mcp: new McpRegistry(new McpServerRepository(infra.db), infra.logger)
});