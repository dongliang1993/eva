import type { SystemModelMessage } from "ai";

import { createSubagentPromptSection } from "../prompts/sections/subagents.js";
import { SubagentRegistry } from "../subagents/registry.js";
import { createTaskTool } from "../tools/task/index.js";
import { withApproval } from "../tools/with-approval.js";
import { LeadAgent } from "./lead-agent.js";
import type { CreateAgentOptions, Agent } from "./types.js";

const appendPromptSection = (
  base: string | SystemModelMessage | undefined,
  heading: string,
  body: string
): string => {
  const text =
    typeof base === "object" && base !== null && base.role === "system"
      ? (typeof base.content === "string" ? base.content : "")
      : (base ?? "");

  return `${text}\n\n## ${heading}\n\n${body}`;
};

export const createAgent = (options: CreateAgentOptions): Agent => {
  const { subagents, requestApproval, ...rest } = options;

  // 危险工具统一在 createAgent 一层包装 execute(两个分支共用,子代理也自动继承
  // 审批)。不再把 requestApproval 传给 LeadAgent —— 审批逻辑完全收敛到 withApproval。
  const tools = requestApproval
    ? (rest.tools ?? []).map((t) => withApproval(t, requestApproval))
    : rest.tools;

  if (subagents && subagents.length > 0) {
    const registry = new SubagentRegistry();

    for (const config of subagents) {
      registry.register(config);
    }

    const baseTools = tools ?? [];

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
        : {}),
      ...(rest.callSettings !== undefined ? { callSettings: rest.callSettings } : {})
    });
  }

  return new LeadAgent({
    model: rest.model,
    ...(tools !== undefined ? { tools } : {}),
    ...(rest.systemPrompt !== undefined
      ? { systemPrompt: rest.systemPrompt }
      : {}),
    ...(rest.maxSteps !== undefined ? { maxSteps: rest.maxSteps } : {}),
    ...(rest.observer !== undefined ? { observer: rest.observer } : {}),
    ...(rest.contextPolicy !== undefined
      ? { contextPolicy: rest.contextPolicy }
      : {}),
    ...(rest.callSettings !== undefined ? { callSettings: rest.callSettings } : {})
  });
};
