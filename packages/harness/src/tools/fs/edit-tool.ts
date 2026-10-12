import { withWorkspaceWrite } from "./workspace-write.js";
import fs from "node:fs/promises";
import { z } from "zod";

import { errorResult, textResult, tool, type PipelineTool } from "../tool.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import type { FsToolBaseOptions } from "./read-file-tool.js";
import { atomicWrite } from "./atomic-write.js";

const EDIT_MAX_BEFORE = 2000;

const editFileSchema = z.object({
  path: z.string().describe("File path relative to workspace root to edit."),
  before: z
    .string().min(1)
    .describe("Exact text to find. Must be unique in the file."),
  after: z.string().describe("Replacement text."),
});

export const createEditTool = (options: FsToolBaseOptions): PipelineTool =>
  tool({
    name: "edit",
    description:
      "Precisely replace text in a file within the workspace. " +
      "`before` must match exactly once, and is replaced by `after`. " +
      "Requires user approval because it modifies the filesystem.",
    inputSchema: editFileSchema,
    async execute({ path: rel, before, after }, extra) {
      return withWorkspaceWrite(options.workRoot, async () => {
        if (before.length > EDIT_MAX_BEFORE) {
          return errorResult(
            `'before' text too long (${before.length} > ${EDIT_MAX_BEFORE}). Edit smaller chunks.`,
          );
        }

        const absolute = resolveWorkspacePath(rel, options.workRoot);
        const current = await fs.readFile(absolute, "utf-8");

        const occurrences = current.split(before).length - 1;
        if (occurrences === 0) {
          return errorResult(`before text not found in ${rel}.`);
        }
        if (occurrences > 1) {
          return errorResult(
            `before text appears ${occurrences} times in ${rel}. Provide more context to make it unique.`,
          );
        }

        const updated = current.replace(before, after);
        extra.signal.throwIfAborted();
        await atomicWrite(absolute, updated, { exists: true, content: current });
        return textResult(
          `Edited ${rel}: replaced 1 occurrence (${before.length} → ${after.length} chars).`,
        );
      }, extra.signal);
    },
  });
