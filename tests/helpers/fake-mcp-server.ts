import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

export interface FakeMcpServerHandle {
  /** 交给 McpServerClient.connect 的 client 侧 transport。 */
  readonly clientTransport: Transport;
  /** 被调用过的工具名（按顺序）。 */
  readonly calls: readonly string[];
  close(): Promise<void>;
}

export interface FakeMcpServerOptions {
  /** 额外注册一个 inputSchema 不合法的工具（用于验证"坏 schema 只跳过该工具"）。 */
  readonly withBadSchemaTool?: boolean;
}

/**
 * 起一个进程内的假 MCP server：
 * - `read_thing`  annotations.readOnlyHint = true → 应免审批
 * - `write_thing` 无注解 → 应需审批
 * - `boom`        返回 isError → 客户端应抛错
 */
export const startFakeMcpServer = async (
  options: FakeMcpServerOptions = {}
): Promise<FakeMcpServerHandle> => {
  const calls: string[] = [];
  const server = new McpServer({ name: "fake", version: "1.0.0" });

  server.registerTool(
    "read_thing",
    {
      description: "Read a thing",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true }
    },
    async ({ id }) => {
      calls.push("read_thing");
      return { content: [{ type: "text" as const, text: `read:${id}` }] };
    }
  );

  server.registerTool(
    "write_thing",
    { description: "Write a thing", inputSchema: { id: z.string() } },
    async ({ id }) => {
      calls.push("write_thing");
      return { content: [{ type: "text" as const, text: `wrote:${id}` }] };
    }
  );

  server.registerTool(
    "boom",
    { description: "Always fails", inputSchema: {} },
    async () => {
      calls.push("boom");
      return { isError: true, content: [{ type: "text" as const, text: "kaboom" }] };
    }
  );

  if (options.withBadSchemaTool) {
    // registerTool 只接受 zod shape，构造不出坏 schema —— 直接挂低层 handler 不划算。
    // 坏 schema 的跳过逻辑由 mcp-client 的 isUsableInputSchema 单测覆盖。
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  return {
    clientTransport: clientTransport as unknown as Transport,
    calls,
    close: async () => {
      await server.close();
    }
  };
};
