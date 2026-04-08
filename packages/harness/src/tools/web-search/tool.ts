import { z } from "zod";

import { buildTool, type AgentTool } from "../../tools.js";
import {
  DuckDuckGoWebSearchClient,
  type DuckDuckGoWebSearchClientOptions
} from "./duckduckgo-client.js";
import type { WebSearchClient } from "./types.js";

export const WEB_SEARCH_TOOL_NAME = "web_search";

const currentYear = (): number => new Date().getUTCFullYear();

const webSearchToolSchema = z.object({
  query: z
    .string()
    .min(2)
    .describe(
      "The search query to execute. Use specific terms such as product names, error messages, or the current year when searching for recent information."
    ),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(10)
    .optional()
    .describe("Optional maximum number of search results to return.")
});

export const getWebSearchToolDescription = (): string =>
  [
    "Search the public web for current or external information.",
    "",
    "When to use:",
    "- The answer depends on up-to-date information, public documentation, or sources outside the repository",
    "- The user asks for recent news, product changes, public references, or current best practices",
    "- You need authoritative URLs to support the final answer",
    "",
    "Output format:",
    "- Returns JSON with query, provider, durationSeconds, totalResults, and results[]",
    "- Each result includes title, url, snippet, and sourceDomain",
    "",
    "Critical requirement:",
    '- After using this tool, include a "Sources:" section in the final answer and list the relevant result URLs',
    `- For recent information, prefer search queries that include the current year (${currentYear()}) when relevant`
  ].join("\n");

export const createWebSearchTool = (client: WebSearchClient): AgentTool =>
  buildTool({
    name: WEB_SEARCH_TOOL_NAME,
    description: getWebSearchToolDescription,
    schema: webSearchToolSchema,
    readOnly: true,
    execute: async ({ query, maxResults }) =>
      JSON.stringify(
        await client.search({
          query,
          ...(maxResults !== undefined ? { maxResults } : {})
        }),
        null,
        2
      )
  });

export const createDuckDuckGoWebSearchTool = (
  options?: DuckDuckGoWebSearchClientOptions
): AgentTool => createWebSearchTool(new DuckDuckGoWebSearchClient(options));
