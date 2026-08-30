import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWebSearchPromptSection,
  createWebSearchTool,
  DuckDuckGoWebSearchClient,
  type WebSearchClient,
  type WebSearchResponse,
} from "../../../packages/harness/src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createWebSearchTool", () => {
  it("normalizes tool input and returns structured JSON output", async () => {
    const search = vi.fn<WebSearchClient["search"]>().mockResolvedValue({
      query: "latest work mi release",
      provider: "stub",
      durationSeconds: 0.123,
      totalResults: 1,
      results: [
        {
          title: "Release Notes",
          url: "https://docs.example.com/releases/latest",
          snippet: "Latest release notes",
          sourceDomain: "docs.example.com",
        },
      ],
    } satisfies WebSearchResponse);
    const tool = createWebSearchTool({ search });

    const raw = await tool.tool.execute!(
      {
        query: "latest work mi release",
        maxResults: 3,
      },
      {
        messages: [],
        toolCallId: "test",
        context: {},
      },
    );

    expect(search).toHaveBeenCalledWith(
      {
        query: "latest work mi release",
        maxResults: 3,
      },
      // T25:execute 第二参数未传 abortSignal → search 收到 undefined。
      undefined,
    );
    expect(JSON.parse(String(raw))).toMatchObject({
      provider: "stub",
      totalResults: 1,
      results: [
        {
          title: "Release Notes",
          url: "https://docs.example.com/releases/latest",
        },
      ],
    });
  });
});

const DDG_HTML_RESPONSE = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Freleases%2Flatest&rut=abc">Release Notes</a>
  <a class="result__snippet">A long but useful snippet about the latest release.</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fexample%2Feva&rut=def">GitHub - eva</a>
  <a class="result__snippet">The official eva repository on GitHub.</a>
</div>
`;

describe("DuckDuckGoWebSearchClient", () => {
  it("fetches DDG HTML and normalizes the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => DDG_HTML_RESPONSE,
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new DuckDuckGoWebSearchClient({ timeoutMs: 5_000 });
    const result = await client.search({
      query: "latest work mi release",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("html.duckduckgo.com/html/");
    expect(calledUrl).toContain("q=latest%20work%20mi%20release");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });

    expect(result).toMatchObject({
      query: "latest work mi release",
      provider: "duckduckgo",
      totalResults: 2,
      results: [
        {
          title: "Release Notes",
          url: "https://docs.example.com/releases/latest",
          snippet: "A long but useful snippet about the latest release.",
          sourceDomain: "docs.example.com",
        },
        {
          title: "GitHub - eva",
          url: "https://github.com/example/eva",
          snippet: "The official eva repository on GitHub.",
          sourceDomain: "github.com",
        },
      ],
    });
    expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("respects maxResults", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => DDG_HTML_RESPONSE,
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new DuckDuckGoWebSearchClient();
    const result = await client.search({
      query: "test",
      maxResults: 1,
    });

    expect(result.totalResults).toBe(1);
    expect(result.results).toHaveLength(1);
  });

  it("throws on HTTP error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new DuckDuckGoWebSearchClient();

    await expect(client.search({ query: "test query" })).rejects.toThrow(
      "Web search request failed (403): Forbidden",
    );
  });

  it("throws on timeout", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), {
        name: "TimeoutError",
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = new DuckDuckGoWebSearchClient({ timeoutMs: 100 });

    await expect(client.search({ query: "test query" })).rejects.toThrow(
      "Web search request timed out after 100ms.",
    );
  });

  it("T25:外部 signal abort → 文案是 canceled 而非 timed out", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("The operation was aborted"), {
                  name: "AbortError",
                }),
              ),
            );
          }),
      ),
    );

    const client = new DuckDuckGoWebSearchClient({ timeoutMs: 60_000 });
    const pending = client.search({ query: "test query" }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow("Web search request canceled.");
  });
});

describe("createWebSearchPromptSection", () => {
  it("adds citation and current-year guidance", () => {
    const section = createWebSearchPromptSection(
      new Date("2026-04-03T00:00:00.000Z"),
    );

    expect(section.heading).toBe("Web Search");
    expect(section.body).toContain("Sources:");
    expect(section.body).toContain("2026");
  });
});
