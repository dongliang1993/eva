import { z } from "zod";

import { textResult, tool, type PipelineTool } from "../tool.js";
import type { MemoryStore } from "./types.js";

const searchMemorySchema = z.object({
  query: z.string().describe("Keyword or phrase to search for in stored memories.")
});

export const createSearchMemoryTool = (store: MemoryStore): PipelineTool =>
  tool({
    name: "search_memory",
    description: [
      "Search through stored memories about the user.",
      "Use this when the answer may depend on the user's identity, preferences, prior decisions, or durable project context.",
      "Use this when the user asks what you know about them, asks you to recall something from before, or references prior conversations.",
      "Use this before save_memory to check if a related memory already exists.",
      "Use facts from this tool or Relevant Memories already supplied in context; do not invent recollections.",
      "Returns matching memories with their IDs (use ID for updates/deletes)."
    ].join("\n"),
    inputSchema: searchMemorySchema,
    annotations: { readOnlyHint: true },
    async execute({ query }) {
      const results = await store.search(query);

      if (results.length === 0) {
        return textResult("No matching memories found.");
      }

      return textResult(JSON.stringify(
        results.map((m) => ({
          id: m.id,
          category: m.category,
          content: m.content,
          updatedAt: m.updatedAt
        })),
        null,
        2,
      ));
    }
  });
