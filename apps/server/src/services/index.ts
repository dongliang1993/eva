import type { RequestApproval } from "@eva/harness";

import { buildChatAgent } from "../agent.js";
import { ApprovalRepository } from "../db/repositories/approval-repository.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { DrizzleMessageRepository } from "../db/repositories/message-repository.js";
import type { AppInfrastructure, AppServices } from "../types/common.js";
import { loadAppSettings } from "./settings-store.js";
import { ApprovalGateway } from "./approval-gateway.js";
import { RunRegistry } from "./run-registry.js";
import { RunApiService } from "./runs.js";
import { SessionService } from "./session.js";

export const buildAppServices = (infra: AppInfrastructure): AppServices => {
  const session = new SessionService(
    new DrizzleSessionRepository(infra.db),
    new DrizzleMessageRepository(infra.db)
  );

  const approvals = new ApprovalGateway(new ApprovalRepository(infra.db));

  // 危险工具执行前的审批:autoApprove 短路,否则挂到 ApprovalGateway 等用户决策。
  const requestApproval: RequestApproval = async ({ toolCallId, toolName, args }) => {
    const settings = loadAppSettings(infra.db, infra.config);
    if (settings.security.autoApproveToolRequests) {
      return true;
    }
    return approvals.ask(toolCallId, "", toolName, args);
  };

  // fs 工具工作区根:优先 TARGET_REPO_ROOT(对话仓库),否则用 activity 默认目录。
  const workRoot = infra.config.TARGET_REPO_ROOT.trim()
    || infra.config.DB_PATH.split("/").slice(0, -2).join("/");

  const agent = buildChatAgent({
    config: infra.config,
    db: infra.db,
    skills: [...infra.skills],
    workRoot,
    ...(requestApproval !== undefined ? { requestApproval } : {}),
    ...(infra.soulSection !== undefined ? { soulSection: infra.soulSection } : {}),
    ...(infra.observer !== undefined ? { observer: infra.observer } : {})
  });

  return {
    runs: new RunApiService(agent),
    session,
    approvals,
    runRegistry: new RunRegistry()
  };
};
