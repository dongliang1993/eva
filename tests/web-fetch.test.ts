import { afterEach, describe, expect, it, vi } from "vitest";

import {
  convertToMarkdown,
  createWebFetchTool,
  WebFetchClient,
  type AgentModel
} from "../packages/harness/src/index.js";
import { createWebFetchPromptSection } from "../packages/harness/src/prompts/sections/web-fetch.js";

const makeMockAIMessage = (text: string) => ({
  content: text,
  additional_kwargs: {},
  response_metadata: {},
  tool_calls: [],
  usage_metadata: undefined
});

const makeMockModel = (responseText: string): AgentModel => ({
  invoke: vi.fn().mockResolvedValue(makeMockAIMessage(responseText)),
  stream: vi.fn()
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// WebFetchClient
// ---------------------------------------------------------------------------

describe("WebFetchClient", () => {
  it("upgrades HTTP to HTTPS", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("<html><body>Hello</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const client = new WebFetchClient();
    const page = await client.fetch("http://example.com");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ method: "GET" })
    );
    expect(page.url).toBe("https://example.com");
    expect(page.statusCode).toBe(200);
  });

  it("throws on HTTP error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("Not Found", { status: 404, statusText: "Not Found" })
      )
    );

    const client = new WebFetchClient();
    await expect(client.fetch("https://example.com/404")).rejects.toThrow(
      "Web fetch failed (404)"
    );
  });

  it("returns cached result on second call", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("body", {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const client = new WebFetchClient();
    const first = await client.fetch("https://example.com");
    const second = await client.fetch("https://example.com");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// convertToMarkdown
// ---------------------------------------------------------------------------

describe("convertToMarkdown", () => {
  it("converts HTML to Markdown", async () => {
    const html = "<h1>Title</h1><p>Some <strong>bold</strong> text.</p>";
    const md = await convertToMarkdown(html, "text/html; charset=utf-8");
    expect(md).toContain("Title");
    expect(md).toContain("**bold**");
  });

  it("passes non-HTML content through unchanged", async () => {
    const plain = "Just plain text content.";
    const md = await convertToMarkdown(plain, "text/plain");
    expect(md).toBe(plain);
  });

  it("truncates content exceeding 80K characters", async () => {
    const longContent = "x".repeat(90_000);
    const md = await convertToMarkdown(longContent, "text/plain");
    expect(md.length).toBeLessThan(90_000);
    expect(md).toContain("[Content truncated at 80000 characters]");
  });
});

// ---------------------------------------------------------------------------
// createWebFetchTool
// ---------------------------------------------------------------------------

describe("createWebFetchTool", () => {
  it("fetches URL, converts to Markdown, and returns AI summary as JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("<html><body><h1>Hello World</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      )
    );

    const mockModel = makeMockModel("This page says Hello World.");

    const tool = createWebFetchTool({ summaryModel: mockModel });
    const raw = await tool.invoke({
      url: "https://example.com",
      prompt: "Summarize this page"
    });

    const result = JSON.parse(raw);
    expect(result.url).toBe("https://example.com");
    expect(result.summary).toBe("This page says Hello World.");
    expect(result.statusCode).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockModel.invoke).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createWebFetchPromptSection
// ---------------------------------------------------------------------------

describe("createWebFetchPromptSection", () => {
  it("contains web_fetch keyword", () => {
    const section = createWebFetchPromptSection();
    expect(section.heading).toBe("Web Fetch");
    expect(section.body).toContain("web_fetch");
    expect(section.body).toContain("web_search");
  });
});
