import type { FastifyInstance } from "fastify";

import {
  registerApprovalPolicyRoutes,
  registerApprovalRoutes,
} from "../modules/approvals/index.js";
import {
  registerHealthRoutes,
  registerStaticRoutes,
} from "../modules/system/index.js";
import { registerMcpServerRoutes } from "../modules/mcp/index.js";
import { registerMemoryRoutes } from "../modules/memory/index.js";
import { registerModelRoutes } from "../modules/providers/index.js";
import { registerPlanWeaveRoutes } from "../modules/plan-weave/index.js";
import { registerProviderRoutes } from "../modules/providers/index.js";
import { registerRunRoutes } from "../modules/runs/index.js";
import { registerSearchRoutes } from "../modules/search/index.js";
import { registerSettingsRoutes } from "../modules/settings/index.js";
import { registerSkillRoutes } from "../modules/skills/index.js";
import { registerThreadRoutes } from "../modules/sessions/index.js";
import { registerTrajectoryRoutes } from "../modules/observability/index.js";
import { registerUsageRoutes } from "../modules/usage/index.js";
import { registerWorkspaceRoutes } from "../modules/workspaces/index.js";

export const registerRoutes = async (app: FastifyInstance): Promise<void> => {
  registerApprovalRoutes(app);
  registerApprovalPolicyRoutes(app);
  registerHealthRoutes(app);
  registerMcpServerRoutes(app);
  registerMemoryRoutes(app);
  registerModelRoutes(app);
  registerPlanWeaveRoutes(app);
  registerProviderRoutes(app);
  registerRunRoutes(app);
  registerSearchRoutes(app);
  registerSettingsRoutes(app);
  registerSkillRoutes(app);
  registerThreadRoutes(app);
  registerTrajectoryRoutes(app);
  registerUsageRoutes(app);
  registerWorkspaceRoutes(app);

  // Static file serving must be last (catches unmatched routes for SPA)
  await registerStaticRoutes(app);
};
