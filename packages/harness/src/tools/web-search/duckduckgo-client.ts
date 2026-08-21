import type {
  WebSearchClient,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 400;
const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";

export interface DuckDuckGoWebSearchClientOptions {
  timeoutMs?: number | undefined;
  defaultMaxResults?: number | undefined;
}

const truncate = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;

const resolveSourceDomain = (rawUrl: string): string | undefined => {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return undefined;
  }
};

const toDurationSeconds = (startedAt: number): number =>
  Number(((performance.now() - startedAt) / 1000).toFixed(3));

const stripHtml = (html: string): string => html.replace(/<[^>]+>/g, "").trim();

const decodeHtmlEntities = (text: string): string =>
  text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

const extractActualUrl = (ddgUrl: string): string => {
  const match = ddgUrl.match(/uddg=([^&]+)/);

  if (match?.[1]) {
    return decodeURIComponent(match[1]);
  }

  return ddgUrl;
};

const RESULT_REGEX =
  /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

const parseSearchResults = (html: string): WebSearchResult[] => {
  const results: WebSearchResult[] = [];

  let match: RegExpExecArray | null;

  while ((match = RESULT_REGEX.exec(html)) !== null) {
    const rawUrl = match[1] ?? "";
    const title = decodeHtmlEntities(stripHtml(match[2] ?? ""));
    const snippet = decodeHtmlEntities(stripHtml(match[3] ?? ""));

    const url = extractActualUrl(rawUrl);

    if (!title || !url) {
      continue;
    }

    const sourceDomain = resolveSourceDomain(url);

    results.push({
      title,
      url,
      snippet: snippet ? truncate(snippet, MAX_SNIPPET_CHARS) : "",
      ...(sourceDomain ? { sourceDomain } : {}),
    });
  }

  return results;
};

export class DuckDuckGoWebSearchClient implements WebSearchClient {
  private readonly timeoutMs: number;
  private readonly defaultMaxResults: number;

  constructor(options: DuckDuckGoWebSearchClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxResults = options.defaultMaxResults ?? DEFAULT_MAX_RESULTS;
  }

  async search(
    input: WebSearchRequest,
    externalSignal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const query = input.query.trim();

    if (!query) {
      throw new Error("Web search query must not be empty.");
    }

    const startedAt = performance.now();
    const maxResults = input.maxResults ?? this.defaultMaxResults;

    // T25:自有超时与 run 取消/toolMs 超时合并 —— 任一触发都断流。
    // 未传 externalSignal 时 AbortSignal.any 只剩 timeout,行为不变。
    const signal =
      externalSignal !== undefined
        ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), externalSignal])
        : AbortSignal.timeout(this.timeoutMs);

    let response: Response;

    try {
      response = await fetch(`${DDG_HTML_URL}?q=${encodeURIComponent(query)}`, {
        method: "GET",
        headers: { "User-Agent": DEFAULT_USER_AGENT },
        signal,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        if (externalSignal?.aborted === true) {
          throw new Error("Web search request canceled.");
        }
        throw new Error(
          `Web search request timed out after ${this.timeoutMs}ms.`,
        );
      }

      throw error;
    }

    if (!response.ok) {
      throw new Error(
        `Web search request failed (${response.status}): ${response.statusText}`,
      );
    }

    const html = await response.text();
    const allResults = parseSearchResults(html);
    const results = allResults.slice(0, maxResults);

    return {
      query,
      provider: "duckduckgo",
      durationSeconds: toDurationSeconds(startedAt),
      totalResults: results.length,
      results,
    };
  }
}
