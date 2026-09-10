import { z } from "zod";
import { buildTool, type AgentTool } from "../build-tool.js";
import { WebFetchClient, type WebFetchClientOptions } from "./client.js";
import { convertToMarkdown } from "./markdown.js";

export interface CreateWebFetchToolOptions {
  readonly clientOptions?: WebFetchClientOptions;
}

export const createWebFetchTool = (options: CreateWebFetchToolOptions = {}): AgentTool => {
  const client = new WebFetchClient(options.clientOptions);
  return buildTool({
    name: "web_fetch",
    description: "Fetch a web page as Markdown. Use offset to read another portion of a long page.",
    inputSchema: z.object({
      url: z.string().url(),
      offset: z.number().int().nonnegative().default(0),
    }),
    readOnly: true,
    async execute({ url, offset }, options) {
      const page = await client.fetch(url, options?.abortSignal);
      options?.abortSignal?.throwIfAborted();
      const markdown = await convertToMarkdown(page.content, page.contentType);
      const content = markdown.slice(offset, offset + 24_000);
      const nextOffset = offset + content.length;
      return JSON.stringify({
        url: page.url, statusCode: page.statusCode, content,
        ...(nextOffset < markdown.length ? { nextOffset } : {})
      });
    }
  });
};
