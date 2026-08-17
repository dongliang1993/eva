import fs from "node:fs/promises";
import { z } from "zod";

import { buildTool, type AgentTool } from "../../tools.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import { maybeOverflow } from "./tool-overflow.js";

const readFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  offset: z.number().int().min(0).default(0).describe("Zero-based line offset."),
  limit: z.number().int().min(1).max(5000).default(200).describe("Max lines to read.")
});

export interface FsToolBaseOptions {
  /** 工作区根目录,所有相对路径都基于它解析。 */
  readonly workRoot: string;
  /** overflow 落盘目录(通常 {workRoot}/.eva/tool-output)。 */
  readonly overflowDir?: string;
}

export const createReadFileTool = (options: FsToolBaseOptions): AgentTool =>
  buildTool({
    name: "read_file",
    description:
      "Read a text file within the workspace. Supports offset/limit for reading " +
      "a range of lines. Large outputs are truncated with a path for re-reads.",
    schema: readFileSchema,
    readOnly: true,
    async execute({ path: rel, offset, limit }) {
      const absolute = resolveWorkspacePath(rel, options.workRoot);
      const content = await fs.readFile(absolute, "utf-8");
      const lines = content.split("\n");
      const lastLine = lines.length > 0 ? lines.length - 1 : 0;
      const end = Math.min(offset + limit, lines.length);
      const body = lines.slice(offset, end).join("\n");

      const text = `File ${rel}: ${lastLine} line(s). Lines ${offset + 1}-${end}:\n${body}`;

      // 超长输出落盘(只在显式配置了 overflowDir 时),否则截断。
      if (lastLine > end && options.overflowDir) {
        return maybeOverflow(text, options.overflowDir, "read_file") + `\n(shown lines ${offset + 1}-${end})`;
      }

      return text;
    }
  });