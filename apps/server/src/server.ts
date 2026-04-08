import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";

export const startServer = async (): Promise<FastifyInstance> => {
  const app = await buildApp();

  await app.listen({
    host: app.infra.config.HOST,
    port: app.infra.config.PORT
  });

  return app;
};
