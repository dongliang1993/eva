import fs from "node:fs/promises";
import { z } from "zod";

import { buildTool, type AgentTool } from "../build-tool.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import type { FsToolBaseOptions } from "./read-file-tool.js";

const listDirSchema = z.object({
  path: z.string().default(".").describe("Directory path relative to workspace root."),
  includeHidden: z.boolean().default(false).describe("Include dotfiles."),
  maxEntries: z.number().int().min(1).max(1000).default(100).describe("Max entries to list.")
});

export const createListDirTool = (options: FsToolBaseOptions): AgentTool =>
  buildTool({
    name: "list_dir",
    description:
      "List files and directories directly under a directory within the workspace. " +
      "One line per entry (dir/ prefix for directories). Use for exploring structure.",
    inputSchema: listDirSchema,
    readOnly: true,
    async execute({ path: rel, includeHidden, maxEntries }) {
      const absolute = resolveWorkspacePath(rel, options.workRoot);
      const entries = await fs.readdir(absolute, { withFileTypes: true });

      const shown = entries
        .filter((e) => includeHidden || !e.name.startsWith("."))
        .slice(0, maxEntries);

      const lines = shown.map((e) => `${e.isDirectory() ? "dir/" : "    "} ${e.name}`);

      const total = entries.length;
      if (total > shown.length) {
        lines.push(`… ${total - shown.length} more entries (limited to ${maxEntries})`);
      }

      return `(${rel.length ? rel : "."} — ${shown.length}/${total} entries)\n${lines.join("\n")}`;
    }
  });