import type { Skill } from "@eva/harness";
import type { SkillSummary } from "@eva/shared";

/** Public use cases exposed by the skills module. */
export interface SkillsApi {
  /** 进程启动时扫到的技能目录。enabled 恒为 true —— 还没有停用单个技能的能力。 */
  list(): readonly SkillSummary[];
}

export const createSkillsApi = (deps: { readonly skills: readonly Skill[] }): SkillsApi => ({
  list: () =>
    deps.skills.map((skill) => ({
      id: skill.name,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      enabled: true
    }))
});
