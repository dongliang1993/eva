import type { PromptSection } from "../prompts/prompt-builder.js";
import type { Skill } from "./types.js";

export interface SkillsPromptOptions {
  /** T44:server 显式做了 auto-selection 时,空列表的语义是「本轮未选中」,不是「没装 skill」。 */
  readonly selectionApplied?: boolean;
}

export const skillsToPromptSection = (
  skills: Skill[],
  options: SkillsPromptOptions = {}
): PromptSection => ({
  heading: "Available Skills",
  body:
    skills.length === 0
      ? options.selectionApplied === true
        ? "No skills were auto-selected for this turn."
        : "No skills are currently loaded."
      : [
          "You have access to skills that provide domain-specific guidance.",
          "The list below contains only skill metadata (name + description); the full instructions are not loaded yet.",
          "",
          ...skills.map(
            (skill) => `- **${skill.name}**: ${skill.description}`
          ),
          "",
          "BLOCKING REQUIREMENT: when a user's request matches a skill, your first action must be to call `read_skill` with that skill name. Do not answer, guess, or execute the task from the description alone; load the full skill content before proceeding."
        ].join("\n")
});
