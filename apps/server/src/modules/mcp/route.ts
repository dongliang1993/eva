import type { FastifyInstance } from "fastify";
import type {
  McpServerConfig,
  McpServerStatus,
  McpServersPayload
} from "@eva/shared";
import { z } from "zod";

import type { McpServerFields } from "./api.js";
import { MCP_SERVER_NAME_PATTERN } from "./mcp-tools.js";

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

/** body 是否是「只启停」的形状:{enabled: boolean} 且不含其它字段。 */
const isEnableOnlyBody = (body: unknown): body is { enabled: boolean } =>
  typeof body === "object" &&
  body !== null &&
  !Array.isArray(body) &&
  typeof (body as { enabled?: unknown }).enabled === "boolean" &&
  Object.keys(body).every((key) => key === "enabled");

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

      // 列表行的开关就发 {enabled},不必带全量配置 —— 单独放行。
      if (isEnableOnlyBody(request.body)) {
        const toggled = await app.api.mcp.setEnabled(id, request.body.enabled);

        if (!toggled) {
          reply.code(404);
          return { error: "MCP server not found" };
        }

        return toggled;
      }

      // 完整配置:校验交给全局 ZodError handler(400 + firstIssue)。
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
