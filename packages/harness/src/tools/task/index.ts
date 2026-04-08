import { z } from "zod";

import type { AgentModel } from "../../models/agent-model.js";
import type { SubagentRegistry } from "../../subagents/registry.js";
import { SubagentExecutor } from "../../subagents/executor.js";
import { buildTool, type AgentTool } from "../../tools.js";

const TASK_TOOL_NAME = "task";
const DEFAULT_SUBAGENT_TYPE = "general-purpose";

const taskSchema = z.object({
  description: z
    .string()
    .describe("A short (3-5 word) description of the task for logging."),
  prompt: z
    .string()
    .describe(
      "The detailed task prompt for the subagent. Be specific and clear about what needs to be done."
    ),
  subagentType: z
    .string()
    .optional()
    .describe(
      "The type of subagent to use. Defaults to general-purpose if omitted."
    )
});

export interface CreateTaskToolOptions {
  readonly registry: SubagentRegistry;
  readonly tools: readonly AgentTool[];
  readonly model: AgentModel;
}

const buildTaskDescription = (registry: SubagentRegistry): string => {
  const names = registry.names();

  return [
    "Delegate a task to a specialized subagent that runs in its own context.",
    "",
    "Use this tool when:",
    "- The task requires multiple steps or tools",
    "- The task would benefit from isolated context",
    "- You want to run complex operations without cluttering the main conversation",
    "",
    "Do NOT use this tool for simple, single-step operations — use tools directly instead.",
    "",
    `Available subagent types: ${names.join(", ")}`
  ].join("\n");
};

export const createTaskTool = ({
  registry,
  tools,
  model
}: CreateTaskToolOptions): AgentTool =>
  buildTool({
    name: TASK_TOOL_NAME,
    description: () => buildTaskDescription(registry),
    schema: taskSchema,
    async execute(input) {
      const subagentType = input.subagentType ?? DEFAULT_SUBAGENT_TYPE;
      const config = registry.get(subagentType);

      if (!config) {
        const available = registry.names().join(", ");

        return `Error: Unknown subagent type "${subagentType}". Available: ${available}`;
      }

      const executor = new SubagentExecutor({
        config,
        tools: [...tools],
        model
      });

      const result = await executor.execute(input.prompt);

      if (result.status === "completed") {
        return `Task completed (${result.durationMs}ms): ${result.text}`;
      }

      return `Task ${result.status} (${result.durationMs}ms): ${result.error ?? "Unknown error"}`;
    }
  });
