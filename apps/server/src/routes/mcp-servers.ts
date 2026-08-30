import type { FastifyInstance } from "fastify";
import type {
  McpServerConfig,
  McpServerStatus,
  McpServersPayload
} from "@eva/shared";
import { z } from "zod";

import type { McpServerFields } from "../api/mcp-api.js";
import { MCP_SERVER_NAME_PATTERN } from "../services/mcp/mcp-tools.js";

const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(MCP_SERVER_NAME_PATTERN, "只允许小写字母、数字、下划线和连字符");

const sharedFields = {
  autoApproveTools: z.array(z.string()).default([]),
  enabled: z.boolean().default(true)
};

/** 用 transport 做判别联合：stdio 必须有 command，http 必须有 url，错误信息才精确。 */
const serverInputSchema = z.discriminatedUnion("transport", [
  z.object({
    name: nameSchema,
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    ...sharedFields
  }),
  z.object({
    name: nameSchema,
    transport: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    ...sharedFields
  })
]);

type ServerInput = z.infer<typeof serverInputSchema>;

const toFields = (input: ServerInput): McpServerFields =>
  input.transport === "stdio"
    ? {
      name: input.name,
      transport: "stdio",
      command: input.command,
      args: input.args,
      env: input.env,
      autoApproveTools: input.autoApproveTools,
      enabled: input.enabled
    }
    : {
      name: input.name,
      transport: "http",
      url: input.url,
      headers: input.headers,
      autoApproveTools: input.autoApproveTools,
      enabled: input.enabled
    };

export const registerMcpServerRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/mcp-servers", async (): Promise<McpServersPayload> =>
    app.api.mcp.describeAll()
  );

  app.post(
    "/api/v1/mcp-servers",
    async (request, reply): Promise<McpServerConfig | { error: string }> => {
      // 校验交给全局 ZodError handler(400 + firstIssue),这里只管业务。
      const input = serverInputSchema.parse(request.body ?? {});
      const result = await app.api.mcp.create(toFields(input));

      if (!result.ok) {
        reply.code(409);
        return { error: `已存在名为 "${input.name}" 的 MCP server` };
      }

      reply.code(201);
      return result.server;
    }
  );

  app.put(
    "/api/v1/mcp-servers/:id",
    async (request, reply): Promise<McpServerConfig | { error: string }> => {
      const { id } = request.params as { id: string };
      const existing = app.api.mcp.find(id);

      if (!existing) {
        reply.code(404);
        return { error: "MCP server not found" };
      }

      // 来自 mcp.json 的条目：内容以文件为准，UI 只能启停。
      // 这是业务规则(不是校验失败),错误信息要解释为什么,所以不走全局 ZodError handler。
      if (existing.origin === "file") {
        const body = request.body;
        const isEnabledOnly = (
          body !== null &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          (body as { enabled?: unknown }).enabled !== undefined &&
          typeof (body as { enabled?: unknown }).enabled === "boolean" &&
          Object.keys(body).every((key) => key === "enabled")
        );

        if (!isEnabledOnly) {
          reply.code(400);
          return {
            error: "来自 mcp.json 的 server 只能启用/停用；要改配置请编辑 ~/.eva/mcp.json"
          };
        }

        return (await app.api.mcp.setEnabled(id, (body as { enabled: boolean }).enabled))!;
      }

      // 手动 server：校验交给全局 ZodError handler(400 + firstIssue)。
      const input = serverInputSchema.parse(request.body ?? {});
      const result = await app.api.mcp.update(id, toFields(input));

      if (!result.ok) {
        reply.code(409);
        return { error: `已存在名为 "${input.name}" 的 MCP server` };
      }

      return result.server;
    }
  );

  app.delete("/api/v1/mcp-servers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = app.api.mcp.find(id);

    if (!existing) {
      reply.code(404);
      return { error: "MCP server not found" };
    }

    if (existing.origin === "file") {
      reply.code(400);
      return {
        error: "来自 mcp.json 的 server 不能在这里删除；请从 ~/.eva/mcp.json 里移除后重启"
      };
    }

    await app.api.mcp.delete(id);

    reply.code(204);
    return null;
  });

  app.post(
    "/api/v1/mcp-servers/:id/reconnect",
    async (request, reply): Promise<McpServerStatus | { error: string }> => {
      const { id } = request.params as { id: string };

      if (!app.api.mcp.find(id)) {
        reply.code(404);
        return { error: "MCP server not found" };
      }

      return app.api.mcp.reconnect(id);
    }
  );
};
