import type { FastifyInstance } from "fastify";

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

export const registerRoutes = async (app: FastifyInstance): Promise<void> => {
  registerHealthRoutes(app);
  registerMemoryRoutes(app);
  registerModelRoutes(app);
  registerProviderRoutes(app);
  registerRunRoutes(app);
  registerSearchRoutes(app);
  registerSettingsRoutes(app);
  registerSkillRoutes(app);
  registerThreadRoutes(app);

  // Static file serving must be last (catches unmatched routes for SPA)
  await registerStaticRoutes(app);
};
