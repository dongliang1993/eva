import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { buildTool, type AgentTool } from "../../tools.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import type { FsToolBaseOptions } from "./read-file-tool.js";
import { maybeOverflow } from "./tool-overflow.js";

const grepSchema = z.object({
  pattern: z.string().describe("Substring or regex literal to search for in file contents."),
  path: z.string().default(".").describe("Directory or file to search, relative to workspace root."),
  maxMatches: z.number().int().min(1).max(200).default(50).describe("Max matches to return.")
});

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".eva", ".next"]);

const walk = (dir: string, depth: number): string[] => {
  if (depth > 6) return [];
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name) || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      out = out.concat(walk(p, depth + 1));
    } else {
      out.push(p);
    }
  }
  return out;
};

export const createGrepTool = (options: FsToolBaseOptions): AgentTool =>
  buildTool({
    name: "grep",
    description:
      "Search file contents for a pattern within the workspace. Returns filename + " +
      "matching line. Use this instead of reading many files when you need to find " +
      "what references something.",
    schema: grepSchema,
    readOnly: true,
    async execute({ pattern, path: rel, maxMatches }) {
      const absolute = resolveWorkspacePath(rel, options.workRoot);
      const stat = statSync(absolute);

      const files = stat.isDirectory() ? walk(absolute, 0) : [absolute];
      const lines: string[] = [];
      const re = new RegExp(pattern, "i");

      outer:
      for (const file of files) {
        try {
          const content = readFileSync(file, "utf-8");
          const fileLines = content.split("\n");
          for (let i = 0; i < fileLines.length; i++) {
            if (re.test(fileLines[i]!)) {
              lines.push(`${path.relative(options.workRoot, file)}:${i + 1}: ${fileLines[i]}`);
              if (lines.length >= maxMatches) break outer;
            }
          }
        } catch {
          // skip unreadable files
        }
      }

      const summary = lines.length === 0
        ? `No matches for "${pattern}" in ${rel}.`
        : `Matching "${pattern}" (${lines.length} shown):\n${lines.join("\n")}`;

      return maybeOverflow(summary, options.overflowDir ?? "", "grep");
    }
  });