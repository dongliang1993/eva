import { jsonSchema, tool, type Tool } from "ai";

import {
  toToolErrorOutput,
  type AgentTool,
  type ToolExecutionOptions,
} from "./build-tool.js";

export interface JsonSchemaToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema 原样（来自 MCP server 的 inputSchema）。 */
  readonly inputSchema: unknown;
  /** T25:可选接 AbortSignal(run 取消 ∪ toolMs 超时)。不接的工具照常工作。 */
  readonly execute: (
    input: unknown,
    options?: ToolExecutionOptions,
  ) => Promise<string>;
  readonly readOnly?: boolean;
  readonly needsApproval?: boolean;
}

/**
 * `buildTool` 的 JSON Schema 版本。
 *
 * 为什么需要两个构造器：内建工具用 zod（写起来类型安全），外部工具（MCP）只能拿到
 * JSON Schema，硬转 zod 既有损又没必要 —— AI SDK 两种都吃。
 * 错误包装共用 `toToolErrorOutput`，这样 stream-part-mapper 的状态判定对两类工具是同一套。
 */
export const buildJsonSchemaTool = (
  definition: JsonSchemaToolDefinition,
): AgentTool => {
  const built: Tool = tool({
    description: definition.description,
    // MCP 的 inputSchema 已是 JSON Schema，直接交给 SDK；不做 zod 转换。
    inputSchema: jsonSchema(
      definition.inputSchema as Parameters<typeof jsonSchema>[0],
    ),
    execute: async (input: unknown, options?: ToolExecutionOptions) => {
      try {
        // T25:透传 SDK 的 options(abortSignal 等)。此前连 toolCallId 都没传 ——
        // 行为变更:MCP 工具的 execute 从此能拿到第二参数,依赖"undefined"的
        // 旧代码路径不存在(签名一直是单参)。
        return await definition.execute(input, options);
      } catch (error) {
        return toToolErrorOutput(error);
      }
    },
  });

  return {
    name: definition.name,
    description: definition.description,
    tool: built,
    ...(definition.readOnly !== undefined
      ? { readOnly: definition.readOnly }
      : {}),
    ...(definition.needsApproval !== undefined
      ? { needsApproval: definition.needsApproval }
      : {}),
  };
};
