import { z } from "zod";

import { buildTool, type AgentTool } from "../build-tool.js";
import type { MemoryFileStore } from "./memory-files.js";

const appendMemorySchema = z.object({
  note: z.string()
    .describe(
      "The note to append to today's daily memory file. " +
      "A short, factual line; ephemeral events and decisions belong here, not in long-term memory."
    ),
  date: z.string()
    .optional()
    .describe(
      "The YYYY-MM-DD date to append to (defaults to today). " +
      "Use only when you explicitly want to log under a past date."
    )
});

export const createAppendMemoryTool = (store: MemoryFileStore): AgentTool =>
  buildTool({
    name: "append_memory",
    description: [
      "Append a line to TODAY's daily memory note (`memory/YYYY-MM-DD.md`), creating the file and its `# date` heading if missing.",
      "Use this for ephemeral, day-stamped facts and decisions — NOT for stable preferences or long-running constraints.",
      "Differentiate from `save_memory` (DB) and `update_long_term_memory` (MEMORY.md):",
      "- `append_memory` → a dated diary entry (recent days are injected into your context each turn)",
      "- `update_long_term_memory` → a stable fact you want injected EVERY turn (ask yourself: is this worth tokens every single turn?)",
      "- `save_memory` → a searchable fact that is NOT worth carrying every turn, but may matter later",
      "Prefer note-taking that reads like a diary: the date is the file; you do not need to repeat the date in each line."
    ].join("\n"),
    inputSchema: appendMemorySchema,
    execute: async ({ note, date }) => {
      const today = todayString();
      const targetDate = date ?? today;

      try {
        const savedPath = await store.appendDailyNote(targetDate, note);
        return `Appended (${savedPath}): ${note}`;
      } catch (error) {
        return error instanceof Error ? error.message : "Failed to append memory";
      }
    }
  });

/** YYYY-MM-DD 本地日期。agent tool 在 server 进程里跑,日期语义就是本机当天。 */
const todayString = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
