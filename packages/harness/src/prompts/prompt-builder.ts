import { thinkingStyleSection } from "./sections/thinking-style.js";
import { responseStyleSection } from "./sections/response-style.js";
import { criticalRemindersSection } from "./sections/critical-reminders.js";

const BASE_PROMPT = [
  "You are the main agent coordinating the task.",
  "Use the available tools whenever the request depends on external, runtime-specific, or project-specific data.",
  "Do not invent tool results or repository facts that you have not been given.",
  "If a tool is unnecessary, answer directly and concisely.",
  "If a tool fails, explain the failure and continue with the best grounded answer you can provide."
].join(" ");

const DEFAULT_SECTIONS: PromptSection[] = [
  thinkingStyleSection,
  responseStyleSection,
  criticalRemindersSection
];

export interface PromptSection {
  heading: string;
  body: string;
}

const formatSection = (section: PromptSection): string =>
  `## ${section.heading}\n\n${section.body}`;

export interface BuildAgentSystemPromptOptions {
  role?: string;
  sections?: PromptSection[];
}

export const buildAgentSystemPrompt = (
  options: BuildAgentSystemPromptOptions = {}
): string => {
  const parts: string[] = [options.role?.trim() || BASE_PROMPT];
  const sections = [...DEFAULT_SECTIONS, ...(options.sections ?? [])];

  parts.push(...sections.map(formatSection));

  return parts.join("\n\n");
};
