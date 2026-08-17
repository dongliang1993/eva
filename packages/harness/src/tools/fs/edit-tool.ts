import fs from "node:fs/promises";
import { z } from "zod";

import { buildTool, type AgentTool } from "../../tools.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import type { FsToolBaseOptions } from "./read-file-tool.js";

const EDIT_MAX_BEFORE = 2000;

const editFileSchema = z.object({
  path: z.string().describe("File path relative to workspace root to edit."),
  before: z.string().describe("Exact text to find. Must be unique in the file."),
  after: z.string().describe("Replacement text.")
});

export const createEditTool = (options: FsToolBaseOptions): AgentTool =>
  buildTool({
    name: "edit",
    description:
      "Precisely replace text in a file within the workspace. " +
      "`before` must match exactly once, and is replaced with `after`. " +
      "Requires user approval because it modifies the filesystem.",
    schema: editFileSchema,
    requiresApproval: true,
    async execute({ path: rel, before, after }) {
      if (before.length > EDIT_MAX_BEFORE) {
        return `[Tool Error] 'before' text too long (${before.length} > ${EDIT_MAX_BEFORE}). Edit smaller chunks.`;
      }

      const absolute = resolveWorkspacePath(rel, options.workRoot);
      const content = await fs.readFile(absolute, "utf-8");
      const occurrences = content.split(before).length - 1;

      if (occurrences === 0) {
        return `[Tool Error] before text not found in ${rel}.`;
      }
      if (occurrences > 1) {
        return `[Tool Error] before text appears ${occurrences} times in ${rel}. Provide more context to make it unique.`;
      }

      const updated = content.replace(before, after);
      await fs.writeFile(absolute, updated, "utf-8");
      return `Edited ${rel}: replaced 1 occurrence (${before.length} → ${after.length} chars).`;
    }
  });