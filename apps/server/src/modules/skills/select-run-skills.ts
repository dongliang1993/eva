import type { Skill } from "@eva/harness";

import type { AppDatabase } from "../../db/index.js";
import type { AgentFactory } from "../runs/index.js";
import { DrizzleSessionSkillSelectionRepository } from "./session-skill-selection-repository.js";

/** Alma 的 Bash+Skill 映射;tool_search 是 Eva T43 的发现入口,必须一起保底。 */
const ALWAYS_ACTIVE_TOOL_NAMES = ["bash", "read_skill", "tool_search"] as const;

export interface RunSkillSelection {
  readonly selectedSkills: Skill[];
  readonly preferredToolNames: string[];
  readonly usedFallback: boolean;
}

const uniquePush = (target: string[], values: readonly string[]): void => {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
};

/**
 * T44:always-inject ∪ thread 累积 ∪ 本轮 LLM 新选。
 * 选中集只决定两件事:prompt 列哪些 metadata、preferredToolNames 并哪些 allowed-tools。
 */
export const selectRunSkills = async (options: {
  readonly db: AppDatabase;
  readonly skills: readonly Skill[];
  readonly agents: AgentFactory;
  readonly sessionId: string;
  readonly modelId: string;
  readonly humanText: string;
}): Promise<RunSkillSelection> => {
  const repo = new DrizzleSessionSkillSelectionRepository(options.db);
  const skillsByName = new Map(options.skills.map((skill) => [skill.name, skill]));

  const alwaysInject = options.skills.filter((skill) => skill.alwaysInject);
  const stored = repo.listBySession(options.sessionId);
  const alreadySelected = new Set<string>([
    ...alwaysInject.map((skill) => skill.name),
    ...stored.map((row) => row.skillName),
  ]);

  // 测试桩常只装 build:没有 selectSkillsForRun 时退成「本轮无新选」,
  // always/累积仍生效。生产 app.services.agents 一定有这个方法。
  const selected = options.agents.selectSkillsForRun
    ? await options.agents.selectSkillsForRun({
      modelId: options.modelId,
      humanText: options.humanText,
      alreadySelected: [...alreadySelected],
      maxNew: 5,
    })
    : { selectedNames: [], usedFallback: false };

  const freshNames = selected.selectedNames.filter(
    (name) => skillsByName.has(name) && !alreadySelected.has(name),
  );
  repo.upsertMany(options.sessionId, freshNames, "auto");

  const orderedNames = [
    ...alwaysInject.map((skill) => skill.name),
    ...stored.map((row) => row.skillName),
    ...freshNames,
  ];
  const selectedSkills: Skill[] = [];
  const seen = new Set<string>();
  for (const name of orderedNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const skill = skillsByName.get(name);
    if (skill) selectedSkills.push(skill);
  }

  const preferredToolNames: string[] = [...ALWAYS_ACTIVE_TOOL_NAMES];
  for (const skill of selectedSkills) {
    uniquePush(preferredToolNames, skill.allowedTools);
  }

  return {
    selectedSkills,
    preferredToolNames,
    usedFallback: selected.usedFallback,
  };
};
