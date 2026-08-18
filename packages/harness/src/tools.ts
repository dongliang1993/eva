import { tool, type Tool, type ToolSet } from "ai";
import type { z } from "zod";

// ai 的 Tool 不带 name(name 是 ToolSet 的 key),但 eva 的 LeadAgent 要按 name 查工具
// (toolCall.name → tool)。所以 AgentTool 包一层 name,内部持有 ai Tool。
export interface AgentTool {
  readonly name: string;
  readonly tool: Tool;
  readonly readOnly?: boolean;
  /** 危险工具标记;由 createAgent 用 withApproval 包装 execute 实现闸门。 */
  readonly requiresApproval?: boolean;
}

export interface ToolDefinition<S extends z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string | (() => string);
  schema: S;
  execute: (input: z.infer<S>) => Promise<string>;
  readOnly?: boolean;
  requiresApproval?: boolean;
}

const toErrorOutput = (error: unknown): string =>
  `[Tool Error] ${error instanceof Error ? error.message : "Unknown error"}`;

export const buildTool = <S extends z.ZodObject<z.ZodRawShape>>(
  definition: ToolDefinition<S>
): AgentTool => {
  const description =
    typeof definition.description === "function"
      ? definition.description()
      : definition.description;

  const built: Tool = tool({
    description,
    inputSchema: definition.schema,
    execute: async (input) => {
      try {
        // parse 应用 schema 的 .default() 等默认值,再交给业务 execute。
        const parsed = definition.schema.parse(input);
        return await definition.execute(parsed);
      } catch (error) {
        return toErrorOutput(error);
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

/**
 * 把 AgentTool 数组转成 streamText 需要的 ToolSet (Record<string, Tool>)。
 * key 用工具的 name。streamText 内部按 key 派生 toolName。
 */
export const toToolSet = (tools: readonly AgentTool[]): ToolSet => {
  const set: ToolSet = {};
  for (const agentTool of tools) {
    set[agentTool.name] = agentTool.tool;
  }
  return set;
};
