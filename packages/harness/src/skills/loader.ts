import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSkillFile } from "./parser.js";
import type { Skill } from "./types.js";

const SKILL_FILE_NAME = "SKILL.md";

/**
 * ⚠️ BUNDLED 行程:这个目录从 import.meta.url 推断,打包后会指向
 * Resources/server/dist/bundled —— 不存在(当前 bundled/ 是空目录,所以今天没坏)。
 * 第一个内置 skill 加进去那天它会静默失效。要么随 copy-migrations.mjs 一起拷进 dist,
 * 要么走 extraResources。见 FINDINGS [r4]。
 */
const BUNDLED_SKILLS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "bundled"
);

export interface LoadSkillsOptions {
  /** T44:非法 SKILL.md(skip)的可见出口 —— 不兼容、不兜底,但必须能排查。 */
  readonly onInvalidSkill?: (filePath: string) => void;
}

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
  source: Skill["source"],
  options: LoadSkillsOptions = {}
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

    if (!parsed) {
      options.onInvalidSkill?.(filePath);
      continue;
    }

    skills.push({
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      content: parsed.content,
      filePath,
      source,
      allowedTools: parsed.frontmatter.allowedTools,
      alwaysInject: parsed.frontmatter.alwaysInject ?? false
    });
  }

  return skills;
};

export const loadBundledSkills = (
  options: LoadSkillsOptions = {}
): Promise<Skill[]> => loadSkillsFromDir(BUNDLED_SKILLS_DIR, "bundled", options);

export const loadProjectSkills = (
  skillsDir: string,
  options: LoadSkillsOptions = {}
): Promise<Skill[]> => loadSkillsFromDir(skillsDir, "project", options);

export interface SkillSourceDir {
  readonly dir: string;
  readonly source: Skill["source"];
}

/**
 * 按给定顺序扫描多个目录。同名 skill 后来者不覆盖先到者 —— 用户目录排在前面,
 * 于是用户可以用同名 skill 覆盖内置的。
 */
export const loadSkills = async (
  dirs: readonly SkillSourceDir[],
  options: LoadSkillsOptions = {}
): Promise<Skill[]> => {
  const bundled = await loadBundledSkills(options);
  const byName = new Map<string, Skill>();

  for (const skill of bundled) {
    byName.set(skill.name, skill);
  }

  for (const { dir, source } of dirs) {
    const skills = await loadSkillsFromDir(dir, source, options);

    for (const skill of skills) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};
