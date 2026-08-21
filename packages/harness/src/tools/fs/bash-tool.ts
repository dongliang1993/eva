import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import { buildTool, type AgentTool } from "../build-tool.js";
import type { FsToolBaseOptions } from "./read-file-tool.js";
import { maybeOverflow } from "./tool-overflow.js";

const execFileAsync = promisify(execFile);

const bashSchema = z.object({
  command: z.string().describe("Shell command to run within the workspace."),
  description: z
    .string()
    .describe(
      'Clear, concise description of what this command does in active voice, 5-10 words ' +
        '(shown in the UI as the row title). Examples: "ls" → "List files in current directory"; ' +
        '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".'
    )
});

export const createBashTool = (options: FsToolBaseOptions): AgentTool =>
  buildTool({
    name: "bash",
    description:
      "Run a shell command within the workspace root. Requires user approval " +
      "because it can modify files or have side effects.",
    inputSchema: bashSchema,
    needsApproval: true,
    async execute({ command }) {
      try {
        const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", command], {
          cwd: options.workRoot,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 120_000
        });
        const all = [stdout, stderr].filter(Boolean).join("\n");
        return maybeOverflow(all, options.overflowDir ?? "", "bash");
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; code?: number; signal?: string };
        const detail = [err.stdout, err.stderr].filter(Boolean).join("\n") || "command failed";
        return maybeOverflow(
          `Exit: ${err.code ?? err.signal ?? "error"}\n${detail}`,
          options.overflowDir ?? "",
          "bash"
        );
      }
    }
  });