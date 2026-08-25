/** T43/T44 共用的确定性文本排序原语(tool_search 与 skill auto-select fallback)。 */

export interface TextRankScored {
  readonly name: string;
  readonly score: number;
}

/** camel/Pascal 与 kebab/snake 统一切词；MCP 名(mcp__github__create_issue)也靠它出 server/tool token。 */
export const tokenizeForRank = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export const scoreTextMatch = (
  rawQuery: string,
  queryTokens: readonly string[],
  name: string,
  description: string,
): number => {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) return 0;

  const lowerName = name.toLowerCase();
  let score = 0;

  if (lowerName === query) score += 100;
  if (lowerName.startsWith(query)) score += 40;
  if (lowerName.includes(query)) score += 25;

  const nameTokens = new Set(tokenizeForRank(name));
  const descriptionTokens = new Set(tokenizeForRank(description));

  for (const token of queryTokens) {
    if (nameTokens.has(token)) score += 12;
    else if (descriptionTokens.has(token)) score += 4;
  }

  if (
    queryTokens.length > 0 &&
    queryTokens.every((token) => nameTokens.has(token) || descriptionTokens.has(token))
  ) {
    score += 10;
  }

  return score;
};

export const sortByRank = <T extends TextRankScored>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
