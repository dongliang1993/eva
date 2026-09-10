import { withWorkspaceWrite } from "./workspace-write.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { buildTool, type AgentTool } from "../build-tool.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import type { FsToolBaseOptions } from "./read-file-tool.js";
import { atomicWrite } from "./atomic-write.js";

const writeFileSchema = z.object({
  path: z.string().describe("File path relative to workspace root to write."),
  content: z.string().describe("Full content to write. Overwrites the file."),
  append: z
    .boolean()
    .default(false)
    .describe("Append to file instead of overwriting."),
});

export const createWriteTool = (options: FsToolBaseOptions): AgentTool =>
  buildTool({
    name: "write",
    description:
      "Write (or append to) a file within the workspace. Requires user approval " +
      "because it modifies the filesystem.",
    inputSchema: writeFileSchema,
    needsApproval: true,
    async execute({ path: rel, content, append }, execOptions) {
      return withWorkspaceWrite(options.workRoot, async () => {
        const absolute = resolveWorkspacePath(rel, options.workRoot);
        await fs.mkdir(path.dirname(absolute), { recursive: true });

        if (append) {
          // T23:append 不校验 —— 语义是"追加到终态",不依赖读时状态,O_APPEND 原子性已保证。
          await fs.writeFile(absolute, content, { flag: "a", encoding: "utf-8" });
          return `Wrote ${content.length} chars to ${rel} (append).`;
        }

        const expected = await fs.readFile(absolute, "utf8").then(
          value => ({ exists: true as const, content: value }),
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return { exists: false as const };
            throw error;
          },
        );
        execOptions?.abortSignal?.throwIfAborted();
        await atomicWrite(absolute, content, expected);
        return `Wrote ${content.length} chars to ${rel} (overwrite).`;
      }, execOptions?.abortSignal);
    },
  });
