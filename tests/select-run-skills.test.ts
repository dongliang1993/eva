import { afterEach, describe, expect, it } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import { DrizzleSessionRepository } from "../apps/server/src/db/repositories/session-repository.js";
import { selectRunSkills } from "../apps/server/src/services/skills/select-run-skills.js";
import type { Skill } from "../packages/harness/src/skills/types.js";

let db: AppDatabase | undefined;

afterEach(() => {
  if (db) closeDb(db);
  db = undefined;
});

const skill = (
  name: string,
  allowedTools: string[],
  alwaysInject = false
): Skill => ({
  name,
  description: `${name} description`,
  content: `# ${name}`,
  filePath: `/tmp/${name}/SKILL.md`,
  source: "project",
  allowedTools,
  alwaysInject
});

const fakeAgents = (selectedNames: string[]) =>
  ({
    selectSkillsForRun: async () => ({ selectedNames, usedFallback: false })
  }) as never;

describe("selectRunSkills", () => {
  it("combines always-inject, stored cumulative selections, and fresh LLM selections", async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    new DrizzleSessionRepository(db).create({ id: "s1", title: "test" });

    const skills = [
      skill("always", [], true),
      skill("alpha", ["mcp__x__y"]),
      skill("beta", ["web_fetch"])
    ];

    const first = await selectRunSkills({
      db,
      skills,
      agents: fakeAgents(["alpha"]),
      sessionId: "s1",
      modelId: "provider:model",
      humanText: "alpha task"
    });

    expect(first.selectedSkills.map((s) => s.name)).toEqual(["always", "alpha"]);
    expect(first.preferredToolNames).toEqual([
      "bash",
      "read_skill",
      "tool_search",
      "mcp__x__y"
    ]);

    // 第二轮:LLM 不再返回 alpha,但 thread 累积仍把它带回来。
    const second = await selectRunSkills({
      db,
      skills,
      agents: fakeAgents([]),
      sessionId: "s1",
      modelId: "provider:model",
      humanText: "unrelated"
    });

    expect(second.selectedSkills.map((s) => s.name)).toEqual(["always", "alpha"]);
    expect(second.preferredToolNames).toContain("mcp__x__y");
  });
});
