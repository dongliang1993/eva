import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { autoSelectSkills } from "../../../packages/harness/src/skills/auto-select.js";
import type { Skill } from "../../../packages/harness/src/skills/types.js";

const skill = (name: string, description: string): Skill => ({
  name,
  description,
  content: `# ${name}`,
  filePath: `/tmp/${name}/SKILL.md`,
  source: "project",
  allowedTools: [],
  alwaysInject: false
});

const skills = [
  skill("alpha", "Handle alpha requests"),
  skill("github", "Create and read GitHub issues"),
  skill("already", "Already selected skill")
];

const jsonModel = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: []
    })
  });

describe("autoSelectSkills", () => {
  it("uses the tool model path and filters invalid/already-selected names", async () => {
    const result = await autoSelectSkills({
      model: jsonModel('["alpha", "missing", "already"]'),
      skills,
      humanText: "alpha please",
      alreadySelected: ["already"]
    });

    expect(result).toEqual({ selectedNames: ["alpha"], usedFallback: false });
  });

  it("accepts an explicit empty JSON array without fallback", async () => {
    const result = await autoSelectSkills({
      model: jsonModel("[]"),
      skills,
      humanText: "nothing"
    });

    expect(result).toEqual({ selectedNames: [], usedFallback: false });
  });

  it("falls back to deterministic ranking when the model output is not JSON", async () => {
    const result = await autoSelectSkills({
      model: jsonModel("I think github is relevant"),
      skills,
      humanText: "create a github issue"
    });

    expect(result.usedFallback).toBe(true);
    expect(result.selectedNames).toEqual(["github"]);
  });

  it("falls back without throwing when the tool model fails", async () => {
    const boom = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("tool model unavailable");
      }
    });

    const result = await autoSelectSkills({
      model: boom,
      skills,
      humanText: "no match here"
    });

    expect(result.usedFallback).toBe(true);
    expect(result.selectedNames).toEqual([]);
  });
});
