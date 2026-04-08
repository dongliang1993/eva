export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  source: "bundled" | "project";
}

export interface SkillFrontmatter {
  name: string;
  description: string;
}
