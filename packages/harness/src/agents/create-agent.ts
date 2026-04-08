import { SystemMessage } from "@langchain/core/messages";

import { createSubagentPromptSection } from "../prompts/sections/subagents.js";
import { SubagentRegistry } from "../subagents/registry.js";
import { createTaskTool } from "../tools/task/index.js";
import { LeadAgent } from "./lead-agent.js";
import type { CreateAgentOptions, Agent } from "./types.js";

const appendPromptSection = (
  base: string | SystemMessage | undefined,
  heading: string,
  body: string
): string => {
  const text =
    base instanceof SystemMessage
      ? (typeof base.content === "string" ? base.content : "")
      : (base ?? "");

  return `${text}\n\n## ${heading}\n\n${body}`;
};

export const createAgent = (options: CreateAgentOptions): Agent => {
  const { subagents, ...rest } = options;

  if (subagents && subagents.length > 0) {
    const registry = new SubagentRegistry();

    for (const config of subagents) {
      registry.register(config);
    }

    const baseTools = rest.tools ?? [];

    const taskTool = createTaskTool({
      registry,
      tools: baseTools,
      model: rest.model
    });

    const allTools = [...baseTools, taskTool];
    const section = createSubagentPromptSection(registry);
    const enhancedPrompt = appendPromptSection(
      rest.systemPrompt,
      section.heading,
      section.body
    );

    return new LeadAgent({
      model: rest.model,
      tools: allTools,
      systemPrompt: enhancedPrompt,
      ...(rest.maxSteps !== undefined ? { maxSteps: rest.maxSteps } : {}),
      ...(rest.observer !== undefined ? { observer: rest.observer } : {}),
      ...(rest.contextPolicy !== undefined
        ? { contextPolicy: rest.contextPolicy }
        : {})
    });
  }

  return new LeadAgent({
    model: rest.model,
    ...(rest.tools !== undefined ? { tools: rest.tools } : {}),
    ...(rest.systemPrompt !== undefined
      ? { systemPrompt: rest.systemPrompt }
      : {}),
    ...(rest.maxSteps !== undefined ? { maxSteps: rest.maxSteps } : {}),
    ...(rest.observer !== undefined ? { observer: rest.observer } : {}),
    ...(rest.contextPolicy !== undefined
      ? { contextPolicy: rest.contextPolicy }
      : {})
  });
};
