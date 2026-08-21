export interface WebSearchRequest {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxResults?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedDate?: string;
  sourceDomain?: string;
}

export interface WebSearchResponse {
  query: string;
  provider: string;
  durationSeconds: number;
  totalResults: number;
  results: WebSearchResult[];
}

export interface WebSearchClient {
  /** T25:externalSignal = run 取消 ∪ toolMs 超时,触发时断流。可选,不传行为不变。 */
  search(
    input: WebSearchRequest,
    externalSignal?: AbortSignal,
  ): Promise<WebSearchResponse>;
}
