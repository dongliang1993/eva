import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSkillFile } from "../packages/harness/src/skills/parser.js";
import {
  loadBundledSkills,
  loadProjectSkills,
  loadSkills
} from "../packages/harness/src/skills/loader.js";
import { skillsToPromptSection } from "../packages/harness/src/skills/prompt.js";

const tempDirs: string[] = [];

const createTempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eva-skills-"));

  tempDirs.push(dir);

  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true })
    )
  );
});

describe("parseSkillFile", () => {
  it("parses frontmatter and content from a SKILL.md file", () => {
    const raw = [
      "---",
      "name: test-skill",
      "description: A test skill for unit testing.",
      "---",
      "",
      "# Test Skill",
      "",
      "Some content here."
    ].join("\n");

    const result = parseSkillFile(raw);

    expect(result).toEqual({
      frontmatter: {
        name: "test-skill",
        description: "A test skill for unit testing."
      },
      content: "# Test Skill\n\nSome content here."
    });
  });

  it("returns undefined when frontmatter is missing", () => {
    expect(parseSkillFile("# No frontmatter")).toBeUndefined();
  });

  it("returns undefined when required fields are missing", () => {
    const raw = "---\nname: only-name\n---\nContent";

    expect(parseSkillFile(raw)).toBeUndefined();
  });
});

describe("loadBundledSkills", () => {
  it("returns an empty array when no bundled skills exist", async () => {
    const skills = await loadBundledSkills();

    expect(skills).toEqual([]);
  });
});

describe("loadProjectSkills", () => {
  it("loads skills from a project directory", async () => {
    const dir = await createTempDir();

    await mkdir(path.join(dir, "my-skill"), { recursive: true });
    await writeFile(
      path.join(dir, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: Does things.\n---\n\n# My Skill\n\nInstructions."
    );

    const skills = await loadProjectSkills(dir);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      name: "my-skill",
      description: "Does things.",
      content: "# My Skill\n\nInstructions.",
      filePath: path.join(dir, "my-skill", "SKILL.md"),
      source: "project"
    });
  });

  it("returns empty array for non-existent directory", async () => {
    const skills = await loadProjectSkills("/non/existent/path");

    expect(skills).toEqual([]);
  });
});

describe("loadSkills", () => {
  it("merges bundled and project skills, project overrides bundled", async () => {
    const dir = await createTempDir();

    await mkdir(path.join(dir, "my-tool"), { recursive: true });
    await writeFile(
      path.join(dir, "my-tool", "SKILL.md"),
      "---\nname: my-tool\ndescription: Custom tool skill.\n---\nCustom content."
    );

    const skills = await loadSkills([{ dir, source: "project" }]);
    const myTool = skills.find((s) => s.name === "my-tool");

    expect(myTool).toBeDefined();
    expect(myTool!.source).toBe("project");
    expect(myTool!.description).toBe("Custom tool skill.");
  });

  it("returns only project skills when no bundled skills exist", async () => {
    const skills = await loadSkills([]);

    expect(skills).toEqual([]);
  });

  it("sorts skills by name", async () => {
    const dir = await createTempDir();

    await mkdir(path.join(dir, "zebra"), { recursive: true });
    await writeFile(
      path.join(dir, "zebra", "SKILL.md"),
      "---\nname: zebra\ndescription: Z skill.\n---\nZ content."
    );

    const skills = await loadSkills([{ dir, source: "project" }]);
    const names = skills.map((s) => s.name);

    for (let i = 1; i < names.length; i++) {
      expect(names[i]! >= names[i - 1]!).toBe(true);
    }
  });
});

describe("skillsToPromptSection", () => {
  it("generates a prompt section listing skills", () => {
    const section = skillsToPromptSection([
      {
        name: "test-skill",
        description: "A test skill.",
        content: "...",
        filePath: "/path/to/SKILL.md",
        source: "bundled"
      }
    ]);

    expect(section.heading).toBe("Available Skills");
    expect(section.body).toContain("**test-skill**");
    expect(section.body).toContain("A test skill.");
    expect(section.body).toContain("read_skill");
  });

  it("handles empty skills list", () => {
    const section = skillsToPromptSection([]);

    expect(section.body).toContain("No skills");
  });
});
