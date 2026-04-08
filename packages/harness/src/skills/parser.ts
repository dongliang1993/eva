import type { SkillFrontmatter } from "./types.js";

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

const parseFrontmatterYaml = (yaml: string): Record<string, string> =>
  Object.fromEntries(
    yaml
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => {
        const colonIndex = line.indexOf(":");
        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();

        return [key, value];
      })
  );

export interface ParseSkillFileResult {
  frontmatter: SkillFrontmatter;
  content: string;
}

export const parseSkillFile = (raw: string): ParseSkillFileResult | undefined => {
  const match = raw.match(FRONTMATTER_PATTERN);

  if (!match) {
    return undefined;
  }

  const frontmatterYaml = match[1];
  const content = match[2];

  if (frontmatterYaml === undefined || content === undefined) {
    return undefined;
  }

  const fields = parseFrontmatterYaml(frontmatterYaml);
  const name = fields.name;
  const description = fields.description;

  if (!name || !description) {
    return undefined;
  }

  return {
    frontmatter: { name, description },
    content: content.trim()
  };
};
