import type { FastifyInstance } from "fastify";

/**
 * T33 loopback token 的判定与注册(从 app.ts 抽出,便于路由级测试)。
 *
 * 白名单只放只读/静态;操作面(/api/v1/runs/*)必须带 token。
 * 判定是精确相等 —— 轨迹/导出接口(/api/v1/threads/:id/trajectory、
 * session-log)天然落不进白名单:它们返回 system prompt 与工具入参输出,
 * 比聊天列表敏感得多(契约 10)。谁想改成前缀匹配,先想想自己在放行什么。
 */
export const isLoopbackWhitelisted = (method: string, url: string): boolean => {
  const path = url.split("?")[0] ?? url;
  const upperMethod = method.toUpperCase();

  return (
    path === "/v1/health" ||
    (upperMethod === "GET" && path === "/api/v1/threads") ||
    // 静态资源 + SPA:GET/HEAD 且不命中 /api/ 操作面
    ((upperMethod === "GET" || upperMethod === "HEAD") && !path.startsWith("/api/"))
  );
};

/** 桌面端 main 每次启动重生成、经 env 传入,server 校验 x-eva-token。 */
export const registerLoopbackTokenHook = (
  app: FastifyInstance,
  loopbackToken: string
): void => {
  app.addHook("onRequest", async (request, reply) => {
    if (isLoopbackWhitelisted(request.method, request.url)) {
      return;
    }

    if (request.headers["x-eva-token"] !== loopbackToken) {
      await reply.code(401).send({ error: "Unauthorized: missing or invalid loopback token" });
    }
  });
};
