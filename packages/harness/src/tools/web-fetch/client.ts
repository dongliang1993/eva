const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONTENT_BYTES = 5 * 1024 * 1024; // 5 MB
const CACHE_MAX_ENTRIES = 50;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";

export interface WebFetchClientOptions {
  readonly timeoutMs?: number;
  readonly maxContentBytes?: number;
}

export interface FetchedPage {
  readonly content: string;
  readonly contentType: string;
  readonly statusCode: number;
  readonly bytes: number;
  readonly url: string;
}

interface CacheEntry {
  readonly page: FetchedPage;
  readonly expiresAt: number;
}

const upgradeToHttps = (url: string): string =>
  url.startsWith("http://") ? url.replace("http://", "https://") : url;

export class WebFetchClient {
  private readonly timeoutMs: number;
  private readonly maxContentBytes: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: WebFetchClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  }

  async fetch(url: string): Promise<FetchedPage> {
    const normalizedUrl = upgradeToHttps(url);

    const cached = this.cache.get(normalizedUrl);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.page;
    }

    let response: Response;
    try {
      response = await globalThis.fetch(normalizedUrl, {
        method: "GET",
        headers: { "User-Agent": DEFAULT_USER_AGENT },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "follow"
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new Error(
          `Web fetch timed out after ${this.timeoutMs}ms for ${normalizedUrl}`
        );
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(
        `Web fetch failed (${response.status}): ${response.statusText} for ${normalizedUrl}`
      );
    }

    const contentType = response.headers.get("content-type") ?? "text/html";
    const buffer = await response.arrayBuffer();

    if (buffer.byteLength > this.maxContentBytes) {
      throw new Error(
        `Content too large (${buffer.byteLength} bytes, max ${this.maxContentBytes}) for ${normalizedUrl}`
      );
    }

    const content = new TextDecoder().decode(buffer);

    const page: FetchedPage = {
      content,
      contentType,
      statusCode: response.status,
      bytes: buffer.byteLength,
      url: normalizedUrl
    };

    this.evictExpired();
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(normalizedUrl, {
      page,
      expiresAt: Date.now() + CACHE_TTL_MS
    });

    return page;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }
}
