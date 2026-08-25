import { generateText, type LanguageModel } from "ai";

import {
  scoreTextMatch,
  sortByRank,
  tokenizeForRank,
} from "../search/text-rank.js";
import type { Skill } from "./types.js";

const DEFAULT_MAX_NEW = 5;

export interface AutoSelectSkillsInput {
  readonly model: LanguageModel;
  readonly skills: readonly Skill[];
  readonly humanText: string;
  /** thread 累积 + always-inject,提示模型别重复;fallback 也会排除。 */
  readonly alreadySelected?: readonly string[];
  /** 单次最多新选几个,防一次把 skill 列表塞爆。默认 5。 */
  readonly maxNew?: number;
}

export interface AutoSelectSkillsResult {
  /** 本轮新选中的 skill 名(不含 alreadySelected)。 */
  readonly selectedNames: string[];
  /** true = LLM 路径失败/非法,走了确定性 text-rank fallback。 */
  readonly usedFallback: boolean;
}

const buildSelectionPrompt = (input: {
  readonly skills: readonly Skill[];
  readonly humanText: string;
  readonly alreadySelected: readonly string[];
  readonly maxNew: number;
}): string =>
  [
    "You select the relevant skills for a user request.",
    "Return ONLY a JSON array of skill names. No markdown, no explanation.",
    `Return at most ${input.maxNew} names. Return [] when nothing matches.`,
    "Never return names that are already selected or not present in the catalog.",
    "",
    `Already selected: ${JSON.stringify(input.alreadySelected)}`,
    "",
    "Skill catalog (name — description):",
    ...input.skills.map((skill) => `- ${skill.name} — ${skill.description}`),
    "",
    "User request:",
    input.humanText,
  ].join("\n");

const extractJsonArray = (text: string): unknown => {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
};

const normalizeSelectedNames = (
  value: unknown,
  catalog: ReadonlySet<string>,
  alreadySelected: ReadonlySet<string>,
  maxNew: number,
): string[] => {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!catalog.has(item) || alreadySelected.has(item)) continue;
    if (names.includes(item)) continue;
    names.push(item);
    if (names.length >= maxNew) break;
  }

  return names;
};

const fallbackSelect = (input: {
  readonly skills: readonly Skill[];
  readonly humanText: string;
  readonly alreadySelected: ReadonlySet<string>;
  readonly maxNew: number;
}): string[] => {
  const queryTokens = tokenizeForRank(input.humanText);
  const matches = input.skills
    .filter((skill) => !input.alreadySelected.has(skill.name))
    .map((skill) => ({
      name: skill.name,
      score: scoreTextMatch(
        input.humanText,
        queryTokens,
        skill.name,
        skill.description,
      ),
    }))
    .filter((match) => match.score > 0);

  return sortByRank(matches)
    .slice(0, input.maxNew)
    .map((match) => match.name);
};

/**
 * T44:Alma 对齐的 skill AutoSkillSelection —— 主路径走 tool 槽位 LLM;
 * LLM 失败/输出非法才退 deterministic text-rank。任何失败都不向调用方抛:
 * skill 选择不能炸聊天(与 MCP 失败隔离同一原则)。
 */
export const autoSelectSkills = async (
  input: AutoSelectSkillsInput,
): Promise<AutoSelectSkillsResult> => {
  const maxNew = input.maxNew ?? DEFAULT_MAX_NEW;
  if (maxNew <= 0) return { selectedNames: [], usedFallback: false };

  const catalog = new Set(input.skills.map((skill) => skill.name));
  const alreadySelected = new Set(input.alreadySelected ?? []);

  try {
    const result = await generateText({
      model: input.model,
      prompt: buildSelectionPrompt({
        skills: input.skills,
        humanText: input.humanText,
        alreadySelected: [...alreadySelected],
        maxNew,
      }),
    });
    const parsed = extractJsonArray(result.text);

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return { selectedNames: [], usedFallback: false };
      }
      const names = normalizeSelectedNames(parsed, catalog, alreadySelected, maxNew);
      if (names.length > 0) {
        return { selectedNames: names, usedFallback: false };
      }
      // 非法名字过滤后为空 → 视同 LLM 输出不可用,走 fallback。
    }
  } catch {
    // 工具模型不可用/超时 → 直接 fallback,不炸聊天。
  }

  return {
    selectedNames: fallbackSelect({
      skills: input.skills,
      humanText: input.humanText,
      alreadySelected,
      maxNew,
    }),
    usedFallback: true,
  };
};
