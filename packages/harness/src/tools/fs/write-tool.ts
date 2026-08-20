import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { buildTool, type AgentTool } from "../../tools.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import type { FsToolBaseOptions } from "./read-file-tool.js";

const writeFileSchema = z.object({
  path: z.string().describe("File path relative to workspace root to write."),
  content: z.string().describe("Full content to write. Overwrites the file."),
  append: z.boolean().default(false).describe("Append to file instead of overwriting.")
});

export const createWriteTool = (options: FsToolBaseOptions): AgentTool =>
  buildTool({
    name: "write",
    description:
      "Write (or append to) a file within the workspace. Requires user approval " +
      "because it modifies the filesystem.",
    inputSchema: writeFileSchema,
    needsApproval: true,
    async execute({ path: rel, content, append }) {
      const absolute = resolveWorkspacePath(rel, options.workRoot);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, { flag: append ? "a" : "w", encoding: "utf-8" });
      return `Wrote ${content.length} chars to ${rel} (${append ? "append" : "overwrite"}).`;
    }
  });