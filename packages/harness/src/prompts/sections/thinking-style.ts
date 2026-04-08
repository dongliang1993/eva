import type { PromptSection } from "../prompt-builder.js";

export const thinkingStyleSection: PromptSection = {
  heading: "Thinking Style",
  body: [
    "- Think concisely and strategically about the user's request BEFORE taking action",
    "- Break down the task: What is clear? What is ambiguous? What is missing?",
    "- If anything is unclear, ask for clarification before proceeding",
    "- Never write down your full final answer in thinking process, only outline",
    "- After thinking, you MUST provide your actual response to the user"
  ].join("\n")
};
