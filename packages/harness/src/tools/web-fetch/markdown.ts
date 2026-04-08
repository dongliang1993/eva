import type TurndownService from "turndown";

const MAX_MARKDOWN_LENGTH = 80_000;

let turndownInstance: TurndownService | undefined;

const getTurndown = async (): Promise<TurndownService> => {
  if (turndownInstance) {
    return turndownInstance;
  }

  const mod = await import("turndown");
  const Ctor = (
    "default" in mod ? (mod as Record<string, unknown>).default : mod
  ) as typeof TurndownService;
  turndownInstance = new Ctor({
    headingStyle: "atx",
    codeBlockStyle: "fenced"
  });

  turndownInstance.remove(["script", "style", "nav", "footer", "header"]);

  return turndownInstance;
};

const isHtml = (contentType: string): boolean =>
  contentType.toLowerCase().includes("text/html");

const truncate = (text: string, maxLength: number): string =>
  text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength).trimEnd()}\n\n[Content truncated at ${maxLength} characters]`;

export const convertToMarkdown = async (
  content: string,
  contentType: string
): Promise<string> => {
  const text = isHtml(contentType)
    ? (await getTurndown()).turndown(content)
    : content;

  return truncate(text, MAX_MARKDOWN_LENGTH);
};
