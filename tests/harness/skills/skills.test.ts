import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSkillFile } from "../../../packages/harness/src/skills/parser.js";
import {
  loadBundledSkills,
  loadProjectSkills,
  loadSkills
} from "../../../packages/harness/src/skills/loader.js";
import { skillsToPromptSection } from "../../../packages/harness/src/skills/prompt.js";
import { createReadSkillTool } from "../../../packages/harness/src/skills/read-skill-tool.js";
import type { Skill } from "../../../packages/harness/src/skills/types.js";

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

const skillMd = (
  name: string,
  description: string,
  options: { allowedTools?: string; alwaysInject?: boolean; body?: string } = {}
): string =>
  [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `allowed-tools: ${options.allowedTools ?? "[Bash]"}`,
    ...(options.alwaysInject ? ["always-inject: true"] : []),
    "---",
    "",
    options.body ?? `# ${name}\n\nInstructions.`
  ].join("\n");

const testSkill = (overrides: Partial<Skill> = {}): Skill => ({
  name: "test-skill",
  description: "A test skill.",
  content: "UNIQUE_SKILL_BODY_DO_NOT_INJECT",
  filePath: "/path/to/test-skill/SKILL.md",
  source: "bundled",
  allowedTools: [],
  alwaysInject: false,
  ...overrides
});

describe("parseSkillFile", () => {
  it("parses frontmatter and content from a SKILL.md file", () => {
    const result = parseSkillFile(
      skillMd("test-skill", "A test skill for unit testing.", {
        allowedTools: "[Bash, Read]",
        alwaysInject: true,
        body: "# Test Skill\n\nSome content here."
      })
    );

    expect(result).toEqual({
      frontmatter: {
        name: "test-skill",
        description: "A test skill for unit testing.",
        allowedTools: ["Bash", "Read"],
        alwaysInject: true
      },
      content: "# Test Skill\n\nSome content here."
    });
  });

  it("parses block-list allowed-tools", () => {
    const raw = [
      "---",
      "name: block-skill",
      "description: Block list.",
      "allowed-tools:",
      "  - Bash",
      "  - Read",
      "---",
      "Body."
    ].join("\n");

    expect(parseSkillFile(raw)?.frontmatter.allowedTools).toEqual(["Bash", "Read"]);
  });

  it("returns undefined when frontmatter is missing", () => {
    expect(parseSkillFile("# No frontmatter")).toBeUndefined();
  });

  it("returns undefined when required fields are missing", () => {
    expect(parseSkillFile("---\nname: only-name\n---\nContent")).toBeUndefined();
  });

  it("returns undefined when allowed-tools is missing or not a list", () => {
    expect(
      parseSkillFile("---\nname: a\ndescription: b\n---\nContent")
    ).toBeUndefined();
    expect(
      parseSkillFile(
        "---\nname: a\ndescription: b\nallowed-tools: Bash\n---\nContent"
      )
    ).toBeUndefined();
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
      skillMd("my-skill", "Does things.", { body: "# My Skill\n\nInstructions." })
    );

    const skills = await loadProjectSkills(dir);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      name: "my-skill",
      description: "Does things.",
      content: "# My Skill\n\nInstructions.",
      filePath: path.join(dir, "my-skill", "SKILL.md"),
      source: "project",
      allowedTools: ["Bash"],
      alwaysInject: false
    });
  });

  it("skips invalid SKILL.md and reports the file path", async () => {
    const dir = await createTempDir();
    const invalid: string[] = [];

    await mkdir(path.join(dir, "bad-skill"), { recursive: true });
    await writeFile(
      path.join(dir, "bad-skill", "SKILL.md"),
      "---\nname: bad\ndescription: missing allowed-tools\n---\nBody."
    );

    const skills = await loadProjectSkills(dir, {
      onInvalidSkill: (filePath) => invalid.push(filePath)
    });

    expect(skills).toEqual([]);
    expect(invalid).toEqual([path.join(dir, "bad-skill", "SKILL.md")]);
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
      skillMd("my-tool", "Custom tool skill.", { body: "Custom content." })
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
      skillMd("zebra", "Z skill.", { body: "Z content." })
    );

    const skills = await loadSkills([{ dir, source: "project" }]);
    const names = skills.map((s) => s.name);

    for (let i = 1; i < names.length; i++) {
      expect(names[i]! >= names[i - 1]!).toBe(true);
    }
  });
});

describe("skillsToPromptSection", () => {
  it("injects only skill metadata, not the body or file path", () => {
    const section = skillsToPromptSection([testSkill()]);

    expect(section.heading).toBe("Available Skills");
    expect(section.body).toContain("**test-skill**");
    expect(section.body).toContain("A test skill.");
    expect(section.body).toContain("read_skill");
    expect(section.body).toContain("BLOCKING REQUIREMENT");
    expect(section.body).not.toContain("UNIQUE_SKILL_BODY_DO_NOT_INJECT");
    expect(section.body).not.toContain("/path/to/test-skill/SKILL.md");
  });

  it("handles empty skills list", () => {
    const section = skillsToPromptSection([]);

    expect(section.body).toContain("No skills");
  });

  it("uses the not-selected wording when selection was applied and empty", () => {
    const section = skillsToPromptSection([], { selectionApplied: true });

    expect(section.body).toContain("No skills were auto-selected");
  });
});

describe("createReadSkillTool", () => {
  const skill = testSkill({ content: "UNIQUE_SKILL_BODY_DO_LOAD" });

  it("returns full content with the skill file resolution contract", async () => {
    const tool = createReadSkillTool([skill]);
    const result = await tool.tool.execute!(
      { name: "test-skill" },
      { toolCallId: "tc-read-skill" } as never
    );

    expect(result).toContain("# Skill: test-skill");
    expect(result).toContain("**Skill File:** /path/to/test-skill/SKILL.md");
    expect(result).toContain("relative to `/path/to/test-skill`");
    expect(result).toContain("UNIQUE_SKILL_BODY_DO_LOAD");
  });

  it("returns available skills when the name is missing", async () => {
    const tool = createReadSkillTool([skill]);
    const result = await tool.tool.execute!(
      { name: "missing" },
      { toolCallId: "tc-read-skill-missing" } as never
    );

    expect(result).toContain('Skill "missing" not found');
    expect(result).toContain("test-skill");
  });
});
