import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import type { z } from "zod";

export type AgentTool = StructuredToolInterface;

export interface ToolDefinition<S extends z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string | (() => string);
  schema: S;
  execute: (input: z.infer<S>) => Promise<string>;
  readOnly?: boolean;
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

  return tool(
    async (input: z.infer<S>) => {
      try {
        return await definition.execute(input);
      } catch (error) {
        return toErrorOutput(error);
      }
    },
    {
      name: definition.name,
      description,
      schema: definition.schema
    }
  );
};

/**
 * @deprecated Use `buildTool` instead for new tools.
 */
export const createTool = tool;
