import { dirname } from "node:path";

import { z } from "zod";

import { textResult, tool, type PipelineTool } from "../tools/tool.js";
import type { Skill } from "./types.js";

const readSkillSchema = z.object({
  name: z.string().min(1).describe("The name of the skill to read.")
});

export const createReadSkillTool = (skills: Skill[]): PipelineTool => {
  const skillsByName = new Map(skills.map((s) => [s.name, s]));

  return tool({
    name: "read_skill",
    description:
      "Read the full content of a skill by name. Use this to load domain-specific guidance before executing a task.",
    inputSchema: readSkillSchema,
    annotations: { readOnlyHint: true },
    async execute({ name }) {
      const skill = skillsByName.get(name);

      if (!skill) {
        const available = skills.map((s) => s.name).join(", ");

        return textResult(`Skill "${name}" not found. Available skills: ${available || "none"}`);
      }

      return textResult([
        `# Skill: ${skill.name}`,
        "",
        `**Skill File:** ${skill.filePath}`,
        "",
        `IMPORTANT: Any relative file path mentioned by this skill is relative to \`${dirname(skill.filePath)}\`. Read those files with absolute paths.`,
        "",
        skill.content
      ].join("\n"));
    }
  });
};
