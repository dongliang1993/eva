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
    path.resolve(import.meta.dirname, "../../../../web/dist"),
    // Packaged: sibling to server
    path.resolve(import.meta.dirname, "../../../web/dist")
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

  // T33 CSP:renderer 是 HTTP 托管(无 HTML 文件插 meta),CSP 走响应头。
  // connect-src 放行 loopback HTTP/WS(SSE 走 fetch-HTTP,预留 WS);style-src
  // 需 unsafe-inline(Tailwind/inline style)。dev 态 vite(5173)托管不经这里,别加。
  const CSP =
    "default-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; " +
    "img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'";

  const fastifyStatic = await import("@fastify/static");

  await app.register(fastifyStatic.default, {
    root: webDist,
    prefix: "/",
    decorateReply: true,
    setHeaders: (res) => {
      res.setHeader("Content-Security-Policy", CSP);
    }
  });

  // SPA fallback: non-API 404s serve index.html
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      reply.code(404).send({ error: "Not found" });
      return;
    }

    reply.header("Content-Security-Policy", CSP);
    reply.sendFile("index.html", webDist);
  });

  app.log.info({ webDist }, "serving web frontend");
};
