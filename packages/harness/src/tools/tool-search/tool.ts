import { z } from "zod";

import { buildTool, type AgentTool } from "../build-tool.js";
import { rankToolCatalog } from "./search.js";

/** 结构性接口:tools 层不反向 import agents 层,避免 barrel 环。 */
export interface ToolSearchController {
  searchCatalog(): ReadonlyMap<string, AgentTool>;
  activateTools(names: readonly string[]): {
    added: string[];
    alreadyActive: string[];
    omitted: string[];
  };
  isDiscoveryMode(): boolean;
}

const toolSearchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Tool name, server name, or capability keywords to search for."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Maximum number of tools to activate. Defaults to 8."),
});

export const createToolSearchTool = (
  controller: ToolSearchController,
): AgentTool =>
  buildTool({
    name: "tool_search",
    description:
      "Search the available tool catalog and activate matching tools. In discovery mode, activated tools become callable from the next model step.",
    inputSchema: toolSearchSchema,
    readOnly: true,
    execute: async ({ query, limit }) => {
      const catalog = new Map(controller.searchCatalog());
      catalog.delete("tool_search");

      const matches = rankToolCatalog(query, catalog, limit ?? 8);
      if (matches.length === 0) {
        return (
          `No tools matched "${query}". Try a tool name, an MCP server name ` +
          "(mcp__<server>__<tool>), or a domain such as fs, bash, web, memory, skill."
        );
      }

      const byName = new Map(matches.map((match) => [match.name, match]));
      const activation = controller.activateTools(matches.map((match) => match.name));
      const lines: string[] = [];

      const format = (name: string): string =>
        `- ${name} — ${byName.get(name)?.description || "No description."}`;

      if (controller.isDiscoveryMode()) {
        if (activation.added.length > 0) {
          lines.push(
            "Activated tools (callable from the next model step):",
            ...activation.added.map(format),
          );
        }
        if (activation.alreadyActive.length > 0) {
          lines.push(
            "Already active:",
            ...activation.alreadyActive.map(format),
          );
        }
        if (activation.omitted.length > 0) {
          lines.push(
            "Omitted due to activation cap:",
            ...activation.omitted.map(format),
          );
        }
      } else {
        lines.push(
          "Matching tools (already available):",
          ...matches.map((match) => format(match.name)),
        );
      }

      return lines.join("\n");
    },
  });
