import { z } from "zod";

import { buildTool, type AgentTool } from "../../tools.js";
import type { MemoryCategory, MemoryStore } from "./types.js";

const saveMemorySchema = z.object({
  content: z.string().describe(
    "The fact, preference, or information to remember. Be concise and specific."
  ),
  category: z
    .enum(["user", "preference", "project", "decision", "knowledge"])
    .optional()
    .describe(
      "Category: user=personal info, preference=habits/style, project=project facts, decision=decisions made, knowledge=general facts. Defaults to knowledge. " +
      "Still, only save here if this fact is NOT worth injecting every turn — stable long-term identity/preferences belong in MEMORY.md via update_long_term_memory."
    ),
  updateId: z.string().optional().describe(
    "If updating an existing memory, pass its ID here. The old content will be replaced."
  )
});

export const createSaveMemoryTool = (store: MemoryStore): AgentTool =>
  buildTool({
    name: "save_memory",
    description: [
      "Store a fact or insight in the DATABASE (category: user/preference/project/decision/knowledge).",
      "Use this when the user explicitly asks you to remember/store/save something for later.",
      "Use this when you learn a project fact, a decision and its rationale, a durable project/workflow habit, or a knowledge point that may matter in future conversations but does NOT need to be carried in EVERY turn.",
      "ROUTING (T16): MEMORY.md is the long-term memory injected EVERY turn. Ask yourself: *is this fact worth spending tokens on every single turn?*",
      "  - Yes (stable identity, name, role, long-running preferences, durable constraints) -> use `update_long_term_memory` (MEMORY.md), NOT this tool.",
      "  - Day-stamped ephemeral events -> use `append_memory` (today's note).",
      "  - Everything else -> this tool (searchable DB fact that matters later, but not every turn).",
      "Before saving, ALWAYS call search_memory first to check if a related memory exists.",
      "If it does, pass its ID as updateId to update instead of creating a duplicate.",
      "Do not say you will remember something unless you actually call a tool this turn (save_memory, append_memory, or update_long_term_memory).",
      "",
      "Good to save here:",
      "- Important project facts (category: project)",
      "- Key decisions and their rationale (category: decision)",
      "- Knowledge points / corrections (category: knowledge)",
      "Do NOT save here:",
      "- Stable user identity/preferences/durable constraints -> update_long_term_memory (MEMORY.md)",
      "- Day-stamped ephemeral events -> append_memory (today's note)",
      "- Temporary conversation details",
      "- Information already in the conversation history"
    ].join("\n"),
    inputSchema: saveMemorySchema,
    execute: async ({ content, category, updateId }) => {
      const cat = (category ?? "knowledge") as MemoryCategory;

      if (updateId) {
        const updated = await store.update(updateId, content, cat);
        return updated
          ? `Memory updated (${updated.id}) [${cat}]: ${content}`
          : `Memory ${updateId} not found, saved as new: ${(await store.save(content, cat, "tool_saved")).id}`;
      }

      const entry = await store.save(content, cat, "tool_saved");
      return `Memory saved (${entry.id}) [${cat}]: ${content}`;
    }
  });
