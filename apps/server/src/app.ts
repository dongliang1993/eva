import Fastify from "fastify";
import { ZodError } from "zod";

import { buildInfrastructure } from "./deps.js";
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
  app.decorate("services", buildAppServices(infra));
  await registerRoutes(app);

  return app;
};
