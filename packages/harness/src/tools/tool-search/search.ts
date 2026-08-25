import {
  scoreTextMatch,
  sortByRank,
  tokenizeForRank,
} from "../../search/text-rank.js";
import type { AgentTool } from "../build-tool.js";

export interface ToolCatalogMatch {
  readonly name: string;
  readonly description: string;
  readonly score: number;
}

/**
 * T43 首版 ranker：确定性、无额外模型调用。要换 Alma 那种小模型语义搜索时,
 * 只替换这个纯函数,激活管线(ToolDiscoveryController + activeTools)不动。
 */
export const rankToolCatalog = (
  query: string,
  catalog: ReadonlyMap<string, AgentTool>,
  limit = 8,
): ToolCatalogMatch[] => {
  const queryTokens = tokenizeForRank(query);
  const matches: ToolCatalogMatch[] = [];

  for (const [name, tool] of catalog) {
    const description = tool.description ?? "";
    const score = scoreTextMatch(query, queryTokens, name, description);
    if (score > 0) matches.push({ name, description, score });
  }

  return sortByRank(matches).slice(0, limit);
};
