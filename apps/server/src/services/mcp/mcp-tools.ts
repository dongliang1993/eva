import { buildJsonSchemaTool, type AgentTool } from "@eva/harness";
import type { McpToolSummary } from "@eva/shared";

import type { McpServerRow } from "../../db/repositories/mcp-server-repository.js";
import type { McpToolDescriptor } from "./mcp-client.js";
import type { McpLogger } from "./mcp-config-file.js";

/**
 * 工具名长度上限。OpenAI 的函数名上限是 64 字符，是各家里最紧的一档。
 * 超了就跳过并 warn —— 截断映射需要维护一张反查表，等真有 server 撞上再做。
 */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * server 名字的合法形状。
 * 它直接进工具名（`mcp__<name>__<tool>`），大写与空格会让工具名不可预测 ——
 * 所以在入口就拒绝，而不是悄悄改写。文件同步与 REST 共用这一条规则。
 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9_-]+$/;

/** 工具名前缀。双下划线分隔，与 Claude Code 的 mcp__server__tool 一致。 */
export const mcpToolName = (server: string, tool: string): string =>
  `mcp__${server}__${tool}`;

/**
 * 映射只需要"有哪些工具"和"怎么调"两件事。
 * 用结构类型而不是 `McpServerClient` 具体类：测试能注入假 invoker，
 * 也表明这一层不关心连接是怎么建立的。
 */
export interface McpToolInvoker {
  readonly tools: readonly McpToolDescriptor[];
  callTool(toolName: string, input: unknown): Promise<string>;
}

/**
 * 免审批的两种情形：协议自己声明了 readOnlyHint，或用户把它写进了白名单。
 * 其余一律需审批 —— MCP server 是第三方代码，能发 HTTP、能改文件、能花钱。
 */
const isAutoApproved = (server: McpServerRow, descriptor: McpToolDescriptor): boolean =>
  descriptor.readOnly || server.autoApproveTools.includes(descriptor.name);

/**
 * MCP 工具 → AgentTool。
 *
 * 不需要新的审批机制：`AgentTool.requiresApproval` + `withApproval` 是 R1 T0.4 建好的闸门，
 * MCP 工具只是又一批带标记的工具。
 */
export const toAgentTools = (
  server: McpServerRow,
  invoker: McpToolInvoker,
  logger: McpLogger
): readonly AgentTool[] => {
  const tools: AgentTool[] = [];
  const tooLong: string[] = [];

  for (const descriptor of invoker.tools) {
    const name = mcpToolName(server.name, descriptor.name);

    if (name.length > MAX_TOOL_NAME_LENGTH) {
      tooLong.push(name);
      continue;
    }

    tools.push(
      buildJsonSchemaTool({
        name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        readOnly: descriptor.readOnly,
        ...(isAutoApproved(server, descriptor) ? {} : { requiresApproval: true }),
        execute: (input) => invoker.callTool(descriptor.name, input)
      })
    );
  }

  if (tooLong.length > 0) {
    logger.warn(
      { server: server.name, tools: tooLong, limit: MAX_TOOL_NAME_LENGTH },
      "MCP 工具名超长已跳过（给 server 取个更短的名字可以救回来）"
    );
  }

  return tools;
};

/** 给 UI 看的工具摘要（含免审批标记）。 */
export const toToolSummaries = (
  server: McpServerRow,
  invoker: McpToolInvoker
): readonly McpToolSummary[] =>
  invoker.tools.map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    autoApproved: isAutoApproved(server, descriptor)
  }));
