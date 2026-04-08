import type { PromptSection } from "../prompt-builder.js";

const getCurrentMonthYear = (date: Date): string =>
  new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);

const getCurrentYear = (date: Date): number => date.getUTCFullYear();

export const createWebSearchPromptSection = (
  date: Date = new Date()
): PromptSection => ({
  heading: "Web Search",
  body: [
    "- The `web_search` tool can retrieve up-to-date public web information when the answer depends on current events, recent documentation, or external references",
    "- After using `web_search`, answer in your own words and add a `Sources:` section with the relevant URLs",
    "- Use domain filters when the user requests official docs or a specific website",
    `- The current month is ${getCurrentMonthYear(date)}. For recent information, use the current year ${getCurrentYear(date)} in the query unless the user explicitly asks for another time range`
  ].join("\n")
});
