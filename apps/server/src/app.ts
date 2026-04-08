import Fastify from "fastify";

import { buildInfrastructure } from "./deps.js";
import { registerRoutes } from "./routes/index.js";
import { buildAppServices } from "./services/index.js";

export const buildApp = async () => {
  const infra = await buildInfrastructure();
  const app = Fastify({
    logger: {
      level: infra.config.LOG_LEVEL
    }
  });

  app.decorate("infra", infra);
  app.decorate("services", buildAppServices(infra));
  await registerRoutes(app);

  return app;
};
