import { jsonSchema, tool, type Tool } from "ai";

import { toToolErrorOutput, type AgentTool } from "../tools.js";

export interface JsonSchemaToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema 原样（来自 MCP server 的 inputSchema）。 */
  readonly inputSchema: unknown;
  readonly execute: (input: unknown) => Promise<string>;
  readonly readOnly?: boolean;
  readonly requiresApproval?: boolean;
}

/**
 * `buildTool` 的 JSON Schema 版本。
 *
 * 为什么需要两个构造器：内建工具用 zod（写起来类型安全），外部工具（MCP）只能拿到
 * JSON Schema，硬转 zod 既有损又没必要 —— AI SDK 两种都吃。
 * 错误包装共用 `toToolErrorOutput`，这样 stream-part-mapper 的状态判定对两类工具是同一套。
 */
export const buildJsonSchemaTool = (
  definition: JsonSchemaToolDefinition
): AgentTool => {
  const built: Tool = tool({
    description: definition.description,
    // MCP 的 inputSchema 已是 JSON Schema，直接交给 SDK；不做 zod 转换。
    inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
    execute: async (input: unknown) => {
      try {
        return await definition.execute(input);
      } catch (error) {
        return toToolErrorOutput(error);
      }
    }
  });

  return {
    name: definition.name,
    tool: built,
    ...(definition.readOnly !== undefined ? { readOnly: definition.readOnly } : {}),
    ...(definition.requiresApproval !== undefined
      ? { requiresApproval: definition.requiresApproval }
      : {})
  };
};
