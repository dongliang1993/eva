import { z } from "zod";

import { buildTool, type AgentTool } from "../../tools.js";
import type { MemoryFileStore } from "./memory-files.js";

const readMemoryFileSchema = z.object({
  from: z.string()
    .optional()
    .describe(
      "The memory file to read, relative to the memory root. " +
      "Examples: `MEMORY.md`, `memory/2026-08-19.md`. " +
      "Omit to list the available memory files."
    )
});

export const createReadMemoryFileTool = (store: MemoryFileStore): AgentTool =>
  buildTool({
    name: "read_memory_file",
    description: [
      "Read the full content of a memory file, or list the available memory files.",
      "Use this BEFORE `update_long_term_memory` (you must see the whole file before replacing it).",
      "Use this to recall a past day's note beyond the ones already injected in your context.",
      "- With no `file` argument, lists `MEMORY.md` and the daily note files (newest first) so you know what exists.",
      "- `file: \"MEMORY.md\"` reads the long-term memory file.",
      "- `file: \"memory/YYYY-MM-DD.md\"` reads a specific day's note.",
      "Paths are confined to the memory root; anything escaping the root is rejected."
    ].join("\n"),
    schema: readMemoryFileSchema,
    readOnly: true,
    execute: async ({ from }) => {
      if (from === undefined) {
        const files = await store.list();
        if (files.length === 0) {
          return "No memory files yet.";
        }
        return files.join("\n");
      }

      const content = await store.readFile(from);
      return content !== undefined
        ? content
        : `Memory file not found: ${from}`;
    }
  });
