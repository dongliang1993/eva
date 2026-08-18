import type { FastifyInstance } from "fastify";

import { registerApprovalRoutes } from "./approvals.js";
import { registerHealthRoutes } from "./health.js";
import { registerMemoryRoutes } from "./memories.js";
import { registerModelRoutes } from "./models.js";
import { registerProviderRoutes } from "./providers.js";
import { registerRunRoutes } from "./runs.js";
import { registerSearchRoutes } from "./search.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerSkillRoutes } from "./skills.js";
import { registerStaticRoutes } from "./static.js";
import { registerThreadRoutes } from "./threads.js";
import { registerWorkspaceRoutes } from "./workspaces.js";

export const registerRoutes = async (app: FastifyInstance): Promise<void> => {
  registerApprovalRoutes(app);
  registerHealthRoutes(app);
  registerMemoryRoutes(app);
  registerModelRoutes(app);
  registerProviderRoutes(app);
  registerRunRoutes(app);
  registerSearchRoutes(app);
  registerSettingsRoutes(app);
  registerSkillRoutes(app);
  registerThreadRoutes(app);
  registerWorkspaceRoutes(app);

  // Static file serving must be last (catches unmatched routes for SPA)
  await registerStaticRoutes(app);
};
