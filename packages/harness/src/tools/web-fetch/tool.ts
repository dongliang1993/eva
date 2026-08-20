import { generateText, type LanguageModel } from "ai";
import { z } from "zod";

import { buildTool, type AgentTool } from "../../tools.js";
import { WebFetchClient, type WebFetchClientOptions } from "./client.js";
import { convertToMarkdown } from "./markdown.js";

const WEB_FETCH_TOOL_NAME = "web_fetch";

const webFetchSchema = z.object({
  url: z.string().url().describe("The URL to fetch content from."),
  prompt: z
    .string()
    .describe("What information to extract or summarize from the page.")
});

export interface CreateWebFetchToolOptions {
  readonly summaryModel: LanguageModel;
  readonly clientOptions?: WebFetchClientOptions;
}

export const createWebFetchTool = (
  options: CreateWebFetchToolOptions
): AgentTool => {
  const client = new WebFetchClient(options.clientOptions);

  return buildTool({
    name: WEB_FETCH_TOOL_NAME,
    description:
      "Fetch the content of a URL, convert it to Markdown, and summarize it based on the given prompt. " +
      "Use this after web_search to read specific pages in detail.",
    inputSchema: webFetchSchema,
    async execute(input) {
      const startedAt = performance.now();

      const page = await client.fetch(input.url);
      const markdown = await convertToMarkdown(page.content, page.contentType);

      const summaryPrompt = [
        "Web page content:",
        "---",
        markdown,
        "---",
        "",
        `User request: ${input.prompt}`,
        "",
        "Guidelines:",
        "- Answer the user's request based on the page content above.",
        "- Be concise but thorough.",
        "- If the page doesn't contain the requested information, say so.",
        "- Include relevant quotes or data points when useful."
      ].join("\n");

      const result = await generateText({
        model: options.summaryModel,
        prompt: summaryPrompt
      });

      const summary = result.text;

      const durationMs = Math.round(performance.now() - startedAt);

      return JSON.stringify({
        url: page.url,
        summary,
        statusCode: page.statusCode,
        bytes: page.bytes,
        durationMs
      });
    }
  });
};

