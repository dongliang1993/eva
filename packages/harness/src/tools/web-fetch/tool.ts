import { z } from "zod";
import { textResult, tool, type PipelineTool } from "../tool.js";
import { WebFetchClient, type WebFetchClientOptions } from "./client.js";
import { convertToMarkdown } from "./markdown.js";

export interface CreateWebFetchToolOptions {
  readonly clientOptions?: WebFetchClientOptions;
}

export const createWebFetchTool = (options: CreateWebFetchToolOptions = {}): PipelineTool => {
  const client = new WebFetchClient(options.clientOptions);
  const schema = z.object({
    url: z.string().url(),
    offset: z.number().int().nonnegative().default(0),
  });
  return tool({
    name: "web_fetch",
    description: "Fetch a web page as Markdown. Use offset to read another portion of a long page.",
    inputSchema: schema,
    annotations: { readOnlyHint: true },
    async execute({ url, offset }: z.output<typeof schema>, extra) {
      const page = await client.fetch(url, extra.signal);
      extra.signal.throwIfAborted();
      const markdown = await convertToMarkdown(page.content, page.contentType);
      const content = markdown.slice(offset, offset + 24_000);
      const nextOffset = offset + content.length;
      return textResult(JSON.stringify({
        url: page.url, statusCode: page.statusCode, content,
        ...(nextOffset < markdown.length ? { nextOffset } : {})
      }));
    }
  });
};
