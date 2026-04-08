import type { PromptSection } from "../prompt-builder.js";

export const responseStyleSection: PromptSection = {
  heading: "Response Style",
  body: [
    "- Clear and concise: avoid over-formatting unless requested",
    "- Action-oriented: focus on delivering results, not explaining processes",
    "- Language consistency: respond in the same language as the user",
    "- When presenting analysis results, use structured sections (summary, root cause, action items)",
    "- Include relevant code paths and line numbers when discussing code issues"
  ].join("\n")
};
