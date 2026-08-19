import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";

/**
 * 进程收尾：把释放收敛到 onClose 一条路径上，信号处理只负责触发 app.close()。
 *
 * 为什么必须收尾：stdio 形态的 MCP server 是我们 spawn 的子进程，不显式 close
 * 就会留下孤儿进程（用户会看到 Eva 退出后 npx 还挂着）。
 */
const installShutdownHooks = (app: FastifyInstance): void => {
  app.addHook("onClose", async () => {
    await app.services.mcp.dispose();
  });

  let closing = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) {
      return;
    }

    closing = true;
    app.log.info({ signal }, "shutting down");

    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, "shutdown failed");
    }

    process.exit(0);
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
};

export const startServer = async (): Promise<FastifyInstance> => {
  const app = await buildApp();

  installShutdownHooks(app);

  await app.listen({
    host: app.infra.config.HOST,
    port: app.infra.config.PORT
  });

  return app;
};
