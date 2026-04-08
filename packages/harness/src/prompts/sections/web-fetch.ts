import type { PromptSection } from "../prompt-builder.js";

export const createWebFetchPromptSection = (): PromptSection => ({
  heading: "Web Fetch",
  body: `You can fetch and read the full content of any public URL using the "web_fetch" tool.
Typical workflow: use web_search to find relevant URLs, then web_fetch to read specific pages in detail.
The fetched content is automatically summarized — provide a clear prompt describing what information you need.`
});
