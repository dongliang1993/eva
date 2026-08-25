import type { SkillFrontmatter } from "./types.js";

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

interface ParsedFrontmatterFields {
  readonly scalars: Record<string, string>;
  readonly lists: Record<string, string[]>;
}

/** inline list: [Bash, Read]。显式 [] 是合法声明;缺字段/非 list 才是非法。 */
const parseInlineList = (value: string): string[] | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const items = inner.split(",").map((item) => item.trim());
  return items.every((item) => item.length > 0) ? items : undefined;
};

/**
 * 无 YAML 依赖的最小 frontmatter 解析:
 * - scalar: `key: value`
 * - inline list: `key: [a, b]`
 * - block list: `key:` 后跟 `  - a` 行
 */
const parseFrontmatterYaml = (yaml: string): ParsedFrontmatterFields => {
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let currentListKey: string | undefined;

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      currentListKey = undefined;
      continue;
    }

    if (/^\s*-\s+/.test(line) && currentListKey !== undefined) {
      lists[currentListKey]!.push(trimmed.slice(1).trim());
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      currentListKey = undefined;
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (value.length === 0) {
      lists[key] = [];
      currentListKey = key;
      continue;
    }

    const inlineList = parseInlineList(value);
    if (inlineList !== undefined) {
      lists[key] = inlineList;
    } else {
      scalars[key] = value;
    }
    currentListKey = undefined;
  }

  return { scalars, lists };
};

export interface ParseSkillFileResult {
  frontmatter: SkillFrontmatter;
  content: string;
}

export const parseSkillFile = (raw: string): ParseSkillFileResult | undefined => {
  const match = raw.match(FRONTMATTER_PATTERN);

  if (!match) {
    return undefined;
  }

  const frontmatterYaml = match[1];
  const content = match[2];

  if (frontmatterYaml === undefined || content === undefined) {
    return undefined;
  }

  const { scalars, lists } = parseFrontmatterYaml(frontmatterYaml);
  const name = scalars.name;
  const description = scalars.description;
  const allowedTools = lists["allowed-tools"];

  // T44:硬校验 —— name/description/allowed-tools 任一缺失或形态非法,整个 SKILL.md 不加载。
  if (!name || !description || allowedTools === undefined) {
    return undefined;
  }
  if (allowedTools.some((tool) => tool.length === 0)) {
    return undefined;
  }

  const alwaysInject = scalars["always-inject"] === "true";

  return {
    frontmatter: {
      name,
      description,
      allowedTools,
      ...(alwaysInject ? { alwaysInject: true } : {})
    },
    content: content.trim()
  };
};
