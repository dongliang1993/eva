import {
  toolFromJsonSchema,
  type PipelineTool,
  type ToolResult,
} from "@eva/harness";
import { textResult } from "@eva/harness";
import type { McpServerConfig, McpToolParam, McpToolSummary } from "@eva/shared";

import type { McpToolDescriptor } from "./mcp-client.js";
import type { McpLogger } from "./mcp-config-store.js";

/**
 * 工具名长度上限。OpenAI 的函数名上限是 64 字符，是各家里最紧的一档。
 * 超了就跳过并 warn —— 截断映射需要维护一张反查表，等真有 server 撞上再做。
 */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * server 名字的合法形状。
 * 它直接进工具名（`mcp__<name>__<tool>`），大写与空格会让工具名不可预测 ——
 * 所以在入口就拒绝，而不是悄悄改写。
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
  /** signal = run 取消 ∪ toolMs 超时,触发时中断传输层请求。可选。 */
  callTool(
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string>;
}

/**
 * 免审批的两种情形：协议自己声明了 readOnlyHint，或用户把它写进了白名单。
 * 其余一律走权限链问人 —— MCP server 是第三方代码，能发 HTTP、能改文件、能花钱。
 * 判定只在 UI 摘要(toToolSummaries)与 readOnlyHint 注入时用;权限链由
 * canUseTool 统一判定(不依赖工具自带标记)。
 */
const isAutoApproved = (
  server: McpServerConfig,
  descriptor: McpToolDescriptor,
): boolean =>
  descriptor.readOnly || server.autoApproveTools.includes(descriptor.name);

/** JSON Schema 的 type 值 → 展示文本。数组折成 "a | b"，缺失按 "(unknown)"。 */
const schemaTypeToText = (type: unknown): string => {
  if (typeof type === "string") {
    return type;
  }

  if (Array.isArray(type) && type.every((t): t is string => typeof t === "string")) {
    return type.join(" | ");
  }

  return "(unknown)";
};

/**
 * inputSchema.properties → 参数摘要（声明序）。
 * 只做展示用的一层拍平；枚举等更深的 schema 信息不进 UI 契约 —— 真有需要再说。
 */
const toParams = (inputSchema: unknown): readonly McpToolParam[] => {
  if (typeof inputSchema !== "object" || inputSchema === null) {
    return [];
  }

  const record = inputSchema as Record<string, unknown>;
  const properties = record["properties"];

  if (typeof properties !== "object" || properties === null) {
    return [];
  }

  const required = new Set(
    Array.isArray(record["required"])
      ? record["required"].filter((r): r is string => typeof r === "string")
      : []
  );

  return Object.entries(properties as Record<string, unknown>).map(([name, prop]) => {
    const detail =
      typeof prop === "object" && prop !== null ? (prop as Record<string, unknown>) : {};

    return {
      name,
      type: schemaTypeToText(detail["type"]),
      required: required.has(name),
      description: typeof detail["description"] === "string" ? detail["description"] : ""
    };
  });
};

/**
 * MCP 工具 → PipelineTool。
 *
 * 不需要新的审批机制：权限链(run-permissions)是统一的闸门，
 * MCP 工具只是又一批非只读工具。
 */
export const toAgentTools = (
  server: McpServerConfig,
  invoker: McpToolInvoker,
  logger: McpLogger,
): readonly PipelineTool[] => {
  const tools: PipelineTool[] = [];
  const tooLong: string[] = [];

  for (const descriptor of invoker.tools) {
    const name = mcpToolName(server.name, descriptor.name);

    if (name.length > MAX_TOOL_NAME_LENGTH) {
      tooLong.push(name);
      continue;
    }

    tools.push(
      toolFromJsonSchema({
        name,
        description: descriptor.description,
        inputSchema: {
          type: "json-schema",
          schema:
            typeof descriptor.inputSchema === "object" &&
            descriptor.inputSchema !== null
              ? (descriptor.inputSchema as Record<string, unknown>)
              : { type: "object" },
        },
        annotations: {
          readOnlyHint: descriptor.readOnly,
        },
        // abortSignal 透传给 invoker → 传输层请求可中断。
        execute: async (input, extra): Promise<ToolResult> =>
          textResult(
            await invoker.callTool(descriptor.name, input, extra.signal),
          ),
      }),
    );
  }

  if (tooLong.length > 0) {
    logger.warn(
      { server: server.name, tools: tooLong, limit: MAX_TOOL_NAME_LENGTH },
      "MCP 工具名超长已跳过（给 server 取个更短的名字可以救回来）",
    );
  }

  return tools;
};

/** 给 UI 看的工具摘要（含参数表与免审批标记）。 */
export const toToolSummaries = (
  server: McpServerConfig,
  invoker: McpToolInvoker,
): readonly McpToolSummary[] =>
  invoker.tools.map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    autoApproved: isAutoApproved(server, descriptor),
    params: toParams(descriptor.inputSchema),
  }));
