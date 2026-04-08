import type { PromptSection } from "../prompt-builder.js";
import type { SubagentRegistry } from "../../subagents/registry.js";

export const createSubagentPromptSection = (
  registry: SubagentRegistry
): PromptSection => {
  const entries = registry
    .list()
    .map((c) => `- **${c.name}**: ${c.description}`)
    .join("\n");

  return {
    heading: "Task Delegation",
    body: [
      'You can delegate complex tasks to specialized subagents using the "task" tool.',
      "Subagents run in their own context and return results when complete.",
      "",
      "Available subagent types:",
      entries,
      "",
      "When to delegate:",
      "- Complex tasks requiring multiple steps or tools",
      "- Tasks that produce verbose intermediate output",
      "- When you want to isolate context from the main conversation",
      "",
      "When NOT to delegate:",
      "- Simple, single-step operations (use tools directly)",
      "- Tasks requiring user interaction or clarification"
    ].join("\n")
  };
};
