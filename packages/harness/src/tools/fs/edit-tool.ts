import fs from "node:fs/promises";
import { z } from "zod";

import { buildTool, type AgentTool } from "../build-tool.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import type { FsToolBaseOptions } from "./read-file-tool.js";
import { isStale, snapshotOf, staleFileMessage } from "./write-guard.js";

const EDIT_MAX_BEFORE = 2000;

const editFileSchema = z.object({
  path: z.string().describe("File path relative to workspace root to edit."),
  before: z
    .string()
    .describe("Exact text to find. Must be unique in the file."),
  after: z.string().describe("Replacement text."),
});

export const createEditTool = (options: FsToolBaseOptions): AgentTool =>
  buildTool({
    name: "edit",
    description:
      "Precisely replace text in a file within the workspace. " +
      "`before` must match exactly once, and is replaced by `after`. " +
      "Requires user approval because it modifies the filesystem.",
    inputSchema: editFileSchema,
    needsApproval: true,
    async execute({ path: rel, before, after }) {
      if (before.length > EDIT_MAX_BEFORE) {
        return `Error: 'before' text too long (${before.length} > ${EDIT_MAX_BEFORE}). Edit smaller chunks.`;
      }

      const absolute = resolveWorkspacePath(rel, options.workRoot);
      // T23:先 stat 再读 —— 窗口语义 = "从 stat① 到 stat② 之间没有外部写"。
      // 顺序反了的话 stat① 拿旧值、readFile 读新内容,比对会误判"没变"(坑 3)。
      const snapshot1 = snapshotOf(await fs.stat(absolute));
      let current = await fs.readFile(absolute, "utf-8");

      // T23:写前比对。变了先试放宽(v2.1.208:Claude Code 同款)—— before 对
      // 新内容仍唯一命中就基于新内容继续;否则拒绝,模型重读重试。
      const snapshot2 = snapshotOf(await fs.stat(absolute));
      if (isStale(snapshot1, snapshot2)) {
        current = await fs.readFile(absolute, "utf-8");
      }

      const occurrences = current.split(before).length - 1;
      if (occurrences === 0) {
        // 磁盘在窗口内变过 → 报"被外部改过"(可自愈:重读重试);
        // 没变过 → 就是锚文本选错了(既有语义,保留)。
        return isStale(snapshot1, snapshot2)
          ? staleFileMessage(rel)
          : `Error: before text not found in ${rel}.`;
      }
      if (occurrences > 1) {
        return `Error: before text appears ${occurrences} times in ${rel}. Provide more context to make it unique.`;
      }

      const updated = current.replace(before, after);
      await fs.writeFile(absolute, updated, "utf-8");
      return `Edited ${rel}: replaced 1 occurrence (${before.length} → ${after.length} chars).`;
    },
  });
