import type { PromptSection } from "../prompts/prompt-builder.js";
import type { Skill } from "./types.js";

export const skillsToPromptSection = (skills: Skill[]): PromptSection => ({
  heading: "Available Skills",
  body:
    skills.length === 0
      ? "No skills are currently loaded."
      : [
          "You have access to skills that provide domain-specific guidance.",
          "Use the `read_skill` tool to load a skill's full content when needed.",
          "",
          ...skills.map(
            (skill) => `- **${skill.name}**: ${skill.description}`
          ),
          "",
          "When a user's request matches a skill, call read_skill with the skill name to get detailed instructions before proceeding."
        ].join("\n")
});
