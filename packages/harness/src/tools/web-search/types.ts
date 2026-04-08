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
  search(input: WebSearchRequest): Promise<WebSearchResponse>;
}
