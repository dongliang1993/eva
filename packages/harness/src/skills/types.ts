export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  source: "bundled" | "project";
  /** T44:硬必填 —— 缺/非法 allowed-tools 的 SKILL.md 在 parser 阶段就被拒。 */
  allowedTools: string[];
  alwaysInject: boolean;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  allowedTools: string[];
  alwaysInject?: boolean;
}
