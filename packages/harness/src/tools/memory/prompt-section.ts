import type { PromptSection } from "../../prompts/prompt-builder.js";
import type { MemoryCategory, MemoryEntry } from "./types.js";

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  user: "User",
  preference: "Preferences",
  project: "Project",
  decision: "Decisions",
  knowledge: "Knowledge"
};

const CATEGORY_ORDER: readonly MemoryCategory[] = [
  "user",
  "preference",
  "project",
  "decision",
  "knowledge"
];

/**
 * Format memory entries into a prompt section for context injection.
 * Groups memories by category for better readability.
 */
export const createMemoryPromptSection = (
  memories: readonly MemoryEntry[]
): PromptSection | undefined => {
  if (memories.length === 0) {
    return {
      heading: "Memory",
      body: [
        "You have no stored memories yet.",
        "When you learn important facts about the user (name, preferences, project context),",
        "use the save_memory tool to store them for future conversations."
      ].join("\n")
    };
  }

  const grouped = new Map<MemoryCategory, readonly MemoryEntry[]>();

  for (const category of CATEGORY_ORDER) {
    const entries = memories.filter((m) => m.category === category);
    if (entries.length > 0) {
      grouped.set(category, entries);
    }
  }

  const sections: string[] = [
    "You have the following stored memories about the user.",
    "Use them to personalize responses. If information changes, search and update the memory.",
    ""
  ];

  for (const [category, entries] of grouped) {
    sections.push(`### ${CATEGORY_LABELS[category]}`);
    for (const entry of entries) {
      sections.push(`- ${entry.content}`);
    }
    sections.push("");
  }

  sections.push(`(${memories.length} memories total)`);

  return {
    heading: "Memory",
    body: sections.join("\n")
  };
};
