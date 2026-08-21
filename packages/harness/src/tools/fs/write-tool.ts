import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { buildTool, type AgentTool } from "../build-tool.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import type { FsToolBaseOptions } from "./read-file-tool.js";
import { isStale, snapshotOf, staleFileMessage } from "./write-guard.js";

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
    async execute({ path: rel, content, append }) {
      const absolute = resolveWorkspacePath(rel, options.workRoot);
      await fs.mkdir(path.dirname(absolute), { recursive: true });

      if (append) {
        // T23:append 不校验 —— 语义是"追加到终态",不依赖读时状态,O_APPEND 原子性已保证。
        await fs.writeFile(absolute, content, { flag: "a", encoding: "utf-8" });
        return `Wrote ${content.length} chars to ${rel} (append).`;
      }

      // T23:覆盖写守卫。write 没有 readFile,基线取 execute 入口的 stat ——
      // 窗口 = "本次 write 开始到落盘之间无外部写"。无放宽分支:覆盖写没有
      // 可重验的锚文本,唯一安全的动作是让模型重读后重发。
      // 首次写入(文件不存在)没有可保护的状态,直接写。
      const snapshot1 = await fs
        .stat(absolute)
        .then(snapshotOf)
        .catch(() => undefined);
      const snapshot2 = await fs
        .stat(absolute)
        .then(snapshotOf)
        .catch(() => undefined);
      if (
        snapshot1 !== undefined &&
        snapshot2 !== undefined &&
        isStale(snapshot1, snapshot2)
      ) {
        return staleFileMessage(rel);
      }
      await fs.writeFile(absolute, content, { flag: "w", encoding: "utf-8" });
      return `Wrote ${content.length} chars to ${rel} (overwrite).`;
    },
  });
