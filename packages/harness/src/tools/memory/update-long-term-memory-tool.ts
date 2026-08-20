import { z } from "zod";

import { buildTool, type AgentTool } from "../../tools.js";
import type { MemoryFileStore } from "./memory-files.js";

const updateLongTermMemorySchema = z.object({
  content: z.string()
    .describe(
      "The FULL updated content of MEMORY.md. Read the whole file first with " +
      "`read_memory_file(\"MEMORY.md\")`, then write back the complete file with your changes " +
      "applied. Do NOT send only a partial snippet, diff, or new lines in isolation."
    )
});

export const createUpdateLongTermMemoryTool = (store: MemoryFileStore): AgentTool =>
  buildTool({
    name: "update_long_term_memory",
    description: [
      "Replace the ENTIRE MEMORY.md file with the given content. This tool **REPLACES the whole file**.",
      "Read it first with `read_memory_file(\"MEMORY.md\")`, then write back the full updated content.",
      "If you do not pass the entire file, every fact you omitted is GONE.",
      "MEMORY.md is the long-term memory injected into your context EVERY single turn — keep it short and factual. " +
      "Ephemeral events and day-stamped decisions belong in `append_memory` (the daily note), NOT here.",
      "Before editing: ask yourself if each fact is worth spending tokens on every single turn. " +
      "Stable user identity, preferences, and durable constraints live here; everything else goes in `save_memory` (DB)."
    ].join("\n"),
    inputSchema: updateLongTermMemorySchema,
    execute: async ({ content }) => {
      try {
        const savedPath = await store.writeLongTermMemory(content);
        return `REPLACED ${savedPath} (${content.length} chars)`;
      } catch (error) {
        return error instanceof Error ? error.message : "Failed to update long-term memory";
      }
    }
  });
