import Fastify from "fastify";
import { ZodError } from "zod";

import { buildAppApi } from "./api/index.js";
import { closeDb } from "./db/index.js";
import { buildInfrastructure } from "./deps.js";
import { registerLoopbackTokenHook } from "./loopback.js";
import { registerRoutes } from "./routes/index.js";
import { buildAppServices } from "./services/index.js";

/** zod 报错的第一条 → 一句人能读的话。 */
const firstZodIssue = (error: ZodError): string => {
  const issue = error.issues[0];

  if (!issue) {
    return "请求参数不合法";
  }

  return issue.path.length > 0
    ? `${issue.path.join(".")}: ${issue.message}`
    : issue.message;
};

export const buildApp = async () => {
  const infra = await buildInfrastructure();
  const app = Fastify({
    logger: {
      level: infra.config.LOG_LEVEL
    }
  });

  // T33 loopback token:桌面端 main 每次启动重生成、经 env 传入,server 校验
  // x-eva-token。dev(外部 server,无 env)跳过——浏览器开 5173 调试不被挡。
  // 白名单只放只读/静态;操作面(/api/v1/runs/*)必须带 token。
  const loopbackToken = process.env.EVA_LOOPBACK_TOKEN;

  if (loopbackToken) {
    registerLoopbackTokenHook(app, loopbackToken);
  }

  // 请求体/查询参数校验失败是客户端错误，不是服务端故障。
  // 没有这个 handler 的话 ZodError 会冒泡成 500，调用方看不出自己传错了什么。
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: firstZodIssue(error) });
      return;
    }

    request.log.error({ err: error }, "unhandled route error");
    reply.send(error); // 交回 Fastify 默认处理(保留它对 HTTP 错误的语义)
  });

  app.decorate("infra", infra);
  const services = buildAppServices(infra);
  app.decorate("services", services);
  app.decorate("api", buildAppApi(infra, services));
  app.addHook("preClose", async () => {
    await Promise.all([services.runRegistry.close(), services.memoryAutomation?.close()]);
  });
  app.addHook("onClose", async () => {
    try {
      await services.mcp.dispose();
    } finally {
      closeDb(infra.db);
    }
  });
  await registerRoutes(app);
  services.memoryAutomation?.start();

  // MCP 预热在后台跑,不挡 listen:慢 server 握手最长 15s,串行等待的话
  // 进程要等它才起得来。失败只记日志(连接结果本来就在 registry 状态里),
  // run 侧的 ensureConnected 幂等,没赶上首连的 run 照样自己补。
  services.mcp.ensureConnected().catch((error: unknown) => {
    infra.logger.error({ err: error }, "MCP 启动预热失败");
  });

  return app;
};
