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
import { runToolText } from "../../helpers/run-tool.js";
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

  it("injects full descriptions when they fit the budget", () => {
    const section = skillsToPromptSection(
      [testSkill({ description: "A test skill." })],
      { contextWindowTokens: 200_000 }
    );

    expect(section.body).toContain("A test skill.");
  });

  it("without a budget keeps today's behavior (no truncation)", () => {
    const long = "x".repeat(300);
    const section = skillsToPromptSection([testSkill({ description: long })]);

    expect(section.body).toContain(long);
  });
});

describe("skill listing budget", () => {
  /** 250 字符以上的一条长 description,用于触发截断。 */
  const longDescription = (seed: string): string =>
    (seed + " ").repeat(60).trim();

  const manySkills = (count: number): Skill[] =>
    Array.from({ length: count }, (_, i) =>
      testSkill({
        name: `skill-${String(i).padStart(3, "0")}`,
        description: longDescription(`skill ${i}`),
      })
    );

  it("500 skills with default budget degrade to names-only listing", () => {
    const section = skillsToPromptSection(manySkills(500), {
      contextWindowTokens: 200_000,
    });

    const lines = section.body.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(500);
    // 每条只剩名字:不含 description 的重复正文。
    expect(section.body).not.toContain("skill 0 skill 0");
    // 名字全保留:预算降级不能丢条目,只能丢 description。
    expect(section.body).toContain("**skill-000**");
    expect(section.body).toContain("**skill-499**");
    // 引导语保留 —— 降级后模型仍需被指去 read_skill。
    expect(section.body).toContain("read_skill");
  });

  it("truncates descriptions to fit the budget instead of dropping entries", () => {
    // 10 条长 description,预算 200k 窗口下放不下全量但放得下截断后的。
    const section = skillsToPromptSection(manySkills(10), {
      contextWindowTokens: 200_000,
    });

    const lines = section.body.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(10);
    // 截断后每条仍以 description 开头(带省略号收尾)。
    expect(lines[0]).toContain("skill 0");
    expect(section.body).toContain("…");
  });

  it("caps each description at 250 chars even when budget allows more", () => {
    const long = "y".repeat(400);
    const section = skillsToPromptSection([testSkill({ description: long })], {
      contextWindowTokens: 200_000,
    });

    const line = section.body.split("\n").find((l) => l.startsWith("- "))!;
    expect(line.length).toBeLessThanOrEqual("- **test-skill**: ".length + 250);
  });

  it("alwaysInject skills keep full descriptions through degradation", () => {
    const pinned = testSkill({
      name: "pinned-skill",
      description: longDescription("pinned description"),
      alwaysInject: true
    });
    const section = skillsToPromptSection(
      [...manySkills(500), pinned],
      { contextWindowTokens: 200_000 }
    );

    // 降级到纯名字的目录里,pinned 仍带全文 description。
    expect(section.body).toMatch(/- \*\*pinned-skill\*\*: pinned description/);
  });

  it("no contextWindow → no budget → today's behavior for 500 skills", () => {
    const section = skillsToPromptSection(manySkills(500));

    expect(section.body).toContain("skill 0 skill 0");
  });
});

describe("createReadSkillTool", () => {
  const skill = testSkill({ content: "UNIQUE_SKILL_BODY_DO_LOAD" });

  it("returns full content with the skill file resolution contract", async () => {
    const tool = createReadSkillTool([skill]);
    const result = await runToolText(tool, { name: "test-skill" }, { toolUseID: "tc-read-skill" });

    expect(result).toContain("# Skill: test-skill");
    expect(result).toContain("**Skill File:** /path/to/test-skill/SKILL.md");
    expect(result).toContain("relative to `/path/to/test-skill`");
    expect(result).toContain("UNIQUE_SKILL_BODY_DO_LOAD");
  });

  it("returns available skills when the name is missing", async () => {
    const tool = createReadSkillTool([skill]);
    const result = await runToolText(tool, { name: "missing" }, { toolUseID: "tc-read-skill-missing" });

    expect(result).toContain('Skill "missing" not found');
    expect(result).toContain("test-skill");
  });
});
