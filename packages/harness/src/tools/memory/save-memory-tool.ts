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
      "Category: user=personal info, preference=habits/style, project=project facts, decision=decisions made, knowledge=general facts. Defaults to knowledge."
    ),
  updateId: z.string().optional().describe(
    "If updating an existing memory, pass its ID here. The old content will be replaced."
  )
});

export const createSaveMemoryTool = (store: MemoryStore): AgentTool =>
  buildTool({
    name: "save_memory",
    description: [
      "Store a fact or insight about the user for future reference.",
      "Use this when the user explicitly asks you to remember/store/save something for later.",
      "Use this when you learn a stable personal fact, preference, workflow habit, or durable project context that will likely matter in future conversations.",
      "Before saving, ALWAYS call search_memory first to check if a related memory exists.",
      "If it does, pass its ID as updateId to update instead of creating a duplicate.",
      "Do not say you will remember something unless you actually call this tool.",
      "",
      "Good memories to save:",
      "- User's name, role, preferences (category: user/preference)",
      "- Important project facts (category: project)",
      "- Key decisions and their rationale (category: decision)",
      "- User corrections or clarifications (category: knowledge)",
      "",
      "Do NOT save:",
      "- Temporary conversation details",
      "- Information already in the conversation history"
    ].join("\n"),
    schema: saveMemorySchema,
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
