import type { PromptSection } from "../prompt-builder.js";

export const criticalRemindersSection: PromptSection = {
  heading: "Critical Reminders",
  body: [
    "- Always ground your answers in tool output when available — do not guess or hallucinate",
    "- If a tool call fails, explain the failure clearly and suggest next steps",
    "- Use parallel tool calls when multiple independent pieces of information are needed",
    "- Never invent code, file paths, or stack frames that were not provided by tools",
    "- When analyzing incidents, always state your confidence level and list assumptions"
  ].join("\n")
};
