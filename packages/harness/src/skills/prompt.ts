import type { PromptSection } from "../prompts/prompt-builder.js";
import type { Skill } from "./types.js";

/** 目录只许占上下文窗口的 1%(按字符计)。对齐 Claude Code 的 SKILL_BUDGET_CONTEXT_PERCENT。 */
export const SKILL_LISTING_BUDGET_PERCENT = 0.01;
/** 字符/token 折算(粗估)。预算按字符算,避免为目录引入真 tokenizer。 */
export const CHARS_PER_TOKEN = 4;
/** 无 contextWindow 可用时兜底:1% × 200k tokens × 4 chars。 */
export const DEFAULT_SKILL_LISTING_CHAR_BUDGET = 8_000;
/**
 * 单条 description 硬上限。目录只为发现(read_skill 会读全文),
 * 更长的 when-to-use 只浪费每轮的 token,不提升命中率。
 */
export const MAX_SKILL_LISTING_DESC_CHARS = 250;
/** 均摊到每条的 description 长度低于此值就不如纯名字 —— 信息量趋近于零。 */
export const MIN_SKILL_LISTING_DESC_CHARS = 20;

export interface SkillListingBudget {
  /** 上下文窗口(tokens)。缺省 → 无预算,维持全量注入(向后兼容)。 */
  readonly contextWindowTokens?: number | undefined;
}

export const skillListingCharBudget = (
  budget: SkillListingBudget
): number | undefined => {
  if (budget.contextWindowTokens === undefined) return undefined;
  return Math.max(
    Math.floor(
      budget.contextWindowTokens * CHARS_PER_TOKEN * SKILL_LISTING_BUDGET_PERCENT
    ),
    1
  );
};

const truncateWithEllipsis = (text: string, maxChars: number): string =>
  text.length <= maxChars
    ? text
    : text.slice(0, Math.max(maxChars - 1, 0)) + "…";

const formatEntry = (name: string, description: string): string =>
  `- **${name}**: ${description}`;

/**
 * 预算阶梯(对齐 Claude Code formatCommandsWithinBudget):
 * 1. 全量放得下 → 全量;
 * 2. 放不下 → alwaysInject 豁免不截,其余按剩余预算均摊截断;
 * 3. 均摊后 < MIN 时 → 非 alwaysInject 降级为纯名字。
 * 任何一级都不丢条目 —— 降级只影响 description,名字永远全保留。
 */
export const formatSkillListings = (
  skills: readonly Skill[],
  budget: SkillListingBudget = {}
): string => {
  if (skills.length === 0) return "";

  const charBudget = skillListingCharBudget(budget);

  // 无预算 → 今天的行为:全量注入,不截断。
  if (charBudget === undefined) {
    return skills.map((s) => formatEntry(s.name, s.description)).join("\n");
  }

  const fullEntries = skills.map((skill) => {
    const entry = formatEntry(
      skill.name,
      truncateWithEllipsis(skill.description, MAX_SKILL_LISTING_DESC_CHARS)
    );
    return { skill, entry };
  });
  const fullTotal =
    fullEntries.reduce((sum, e) => sum + e.entry.length, 0) +
    (fullEntries.length - 1);

  if (fullTotal <= charBudget) {
    return fullEntries.map((e) => e.entry).join("\n");
  }

  // 均摊:豁免条目(alwaysInject)永不截断、永不降级为纯名字。
  const exempt = fullEntries.filter((e) => e.skill.alwaysInject);
  const rest = fullEntries.filter((e) => !e.skill.alwaysInject);
  const exemptChars =
    exempt.reduce((sum, e) => sum + e.entry.length + 1, 0) || 0;
  const remainingBudget = charBudget - exemptChars;

  if (rest.length === 0 || remainingBudget < 0) {
    return fullEntries.map((e) => e.entry).join("\n");
  }

  // 剩余预算先扣除名字开销("- **name**: " 的固定部分按名字长度算),
  // 再均摊给 description。
  const restNameOverhead =
    rest.reduce((sum, e) => sum + `- **${e.skill.name}**: `.length, 0) +
    (rest.length - 1);
  const availableForDescs = remainingBudget - restNameOverhead;
  const maxDescLen = Math.floor(availableForDescs / rest.length);

  if (maxDescLen < MIN_SKILL_LISTING_DESC_CHARS) {
    // 极端拥挤:非豁免条目降级为纯名字,豁免条目保留全文。
    return fullEntries
      .map((e) =>
        e.skill.alwaysInject ? e.entry : `- **${e.skill.name}**`
      )
      .join("\n");
  }

  return fullEntries
    .map((e) =>
      e.skill.alwaysInject
        ? e.entry
        : formatEntry(
            e.skill.name,
            truncateWithEllipsis(e.skill.description, maxDescLen)
          )
    )
    .join("\n");
};

export const skillsToPromptSection = (
  skills: readonly Skill[],
  budget: SkillListingBudget = {}
): PromptSection => ({
  heading: "Available Skills",
  body:
    skills.length === 0
      ? "No skills are currently loaded."
      : [
        "You have access to skills that provide domain-specific guidance.",
        "The list below contains only skill metadata (name + description); the full instructions are not loaded yet.",
        "",
        ...formatSkillListings(skills, budget).split("\n"),
        "",
        "BLOCKING REQUIREMENT: when a user's request matches a skill, your first action must be to call `read_skill` with that skill name. Do not answer, guess, or execute the task from the description alone; load the full skill content before proceeding."
      ].join("\n")
});
