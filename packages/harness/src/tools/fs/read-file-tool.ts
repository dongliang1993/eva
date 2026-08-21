import fs from "node:fs/promises";
import { z } from "zod";

import { buildTool, type AgentTool } from "../build-tool.js";
import { resolveReadablePath } from "./resolve-workspace-path.js";
import { maybeOverflow } from "./tool-overflow.js";

const readFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  offset: z.number().int().min(0).default(0).describe("Zero-based line offset."),
  limit: z.number().int().min(1).max(5000).default(200).describe("Max lines to read.")
});

export interface FsToolBaseOptions {
  /** 工作根目录,所有相对路径都基于它解析。 */
  readonly workRoot: string;
  /** overflow 落盘目录(不在工作区内,见 toolOverflowDir)。 */
  readonly overflowDir?: string;
  /** 只读工具额外可读的根(当前只有 overflowDir)。写工具不受它影响。 */
  readonly readableRoots?: readonly string[];
}

export const createReadFileTool = (options: FsToolBaseOptions): AgentTool =>
  buildTool({
    name: "read_file",
    description:
      "Read a text file within the workspace. Supports offset/limit for reading " +
      "a range of lines. Large outputs are truncated with a path for re-reads.",
    inputSchema: readFileSchema,
    readOnly: true,
    async execute({ path: rel, offset, limit }) {
      const absolute = resolveReadablePath(rel, options.workRoot, options.readableRoots ?? []);
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