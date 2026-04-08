import { existsSync } from "node:fs";
import path from "node:path";

import type { FastifyInstance } from "fastify";

/**
 * Resolve the web frontend dist directory.
 * Checks relative to the workspace root (dev) and relative to server dist (packaged).
 */
const resolveWebDist = (): string | undefined => {
  const candidates = [
    // Dev / monorepo: relative to workspace root
    path.resolve(import.meta.dirname, "../../../web/dist"),
    // Packaged: sibling to server
    path.resolve(import.meta.dirname, "../../web/dist")
  ];

  return candidates.find((p) => existsSync(p));
};

export const registerStaticRoutes = async (
  app: FastifyInstance
): Promise<void> => {
  const webDist = resolveWebDist();

  if (!webDist) {
    app.log.debug("No web frontend dist found, skipping static file serving");
    return;
  }

  const fastifyStatic = await import("@fastify/static");

  await app.register(fastifyStatic.default, {
    root: webDist,
    prefix: "/",
    decorateReply: true
  });

  // SPA fallback: non-API 404s serve index.html
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      reply.code(404).send({ error: "Not found" });
      return;
    }

    reply.sendFile("index.html", webDist);
  });

  app.log.info({ webDist }, "serving web frontend");
};
