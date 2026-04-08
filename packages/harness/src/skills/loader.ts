import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSkillFile } from "./parser.js";
import type { Skill } from "./types.js";

const SKILL_FILE_NAME = "SKILL.md";

const BUNDLED_SKILLS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "bundled"
);

const scanDirectory = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await scanDirectory(fullPath)));
    } else if (entry.name === SKILL_FILE_NAME) {
      paths.push(fullPath);
    }
  }

  return paths;
};

const loadSkillsFromDir = async (
  dir: string,
  source: Skill["source"]
): Promise<Skill[]> => {
  try {
    const dirStat = await stat(dir);

    if (!dirStat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const skillFiles = await scanDirectory(dir);
  const skills: Skill[] = [];

  for (const filePath of skillFiles) {
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseSkillFile(raw);

    if (parsed) {
      skills.push({
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        content: parsed.content,
        filePath,
        source
      });
    }
  }

  return skills;
};

export const loadBundledSkills = (): Promise<Skill[]> =>
  loadSkillsFromDir(BUNDLED_SKILLS_DIR, "bundled");

export const loadProjectSkills = (skillsDir: string): Promise<Skill[]> =>
  loadSkillsFromDir(skillsDir, "project");

export const loadSkills = async (
  projectSkillsDir?: string
): Promise<Skill[]> => {
  const bundled = await loadBundledSkills();
  const project = projectSkillsDir
    ? await loadProjectSkills(projectSkillsDir)
    : [];

  const byName = new Map<string, Skill>();

  for (const skill of bundled) {
    byName.set(skill.name, skill);
  }

  for (const skill of project) {
    byName.set(skill.name, skill);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};
