import { z } from "zod";

import { buildTool, type AgentTool } from "../../tools.js";
import type { MemoryStore } from "./types.js";

const searchMemorySchema = z.object({
  query: z.string().describe("Keyword or phrase to search for in stored memories.")
});

export const createSearchMemoryTool = (store: MemoryStore): AgentTool =>
  buildTool({
    name: "search_memory",
    description: [
      "Search through stored memories about the user.",
      "Use this when the answer may depend on the user's identity, preferences, prior decisions, or durable project context.",
      "Use this when the user asks what you know about them, asks you to recall something from before, or references prior conversations.",
      "Use this before save_memory to check if a related memory already exists.",
      "Do not imply you recalled long-term memory unless you actually used this tool.",
      "Returns matching memories with their IDs (use ID for updates/deletes)."
    ].join("\n"),
    schema: searchMemorySchema,
    readOnly: true,
    execute: async ({ query }) => {
      const results = await store.search(query);

      if (results.length === 0) {
        return "No matching memories found.";
      }

      return JSON.stringify(
        results.map((m) => ({
          id: m.id,
          category: m.category,
          content: m.content,
          updatedAt: m.updatedAt
        })),
        null,
        2
      );
    }
  });
