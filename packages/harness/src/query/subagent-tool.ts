import { z } from "zod";

import { textOf, textResult, tool } from "../tools/tool.js";
import { query } from "./query.js";
import type {
  AgentDefinition,
  HarnessMessage,
  Options,
  ToolDefinition,
} from "./types.js";

/**
 * 内置 subagent 工具:读 options.agents,递归 query() 跑子代理。
 * options.agents 为空时不注册这个工具(模型看不见它)。
 *
 * 子代理的消息带 parent_tool_use_id(= 派发它的那次调用的 toolUseID);
 * 子代理与父共用 canUseTool(同一实例,agentID = 子代理名)与 abort 信号。
 * 角色定义从 server 来(FR-009:harness 不再有 SUBAGENT_ROLES)。
 */

const subagentSchema = z.object({
  description: z.string().min(1).describe(
    "A short (3-5 word) description of the delegated task, for display."
  ),
  prompt: z.string().min(1).describe(
    "The complete, self-contained task for the subagent. It does not share this " +
    "conversation's context, so include everything it needs."
  ),
  subagent: z.string().describe(
    "Subagent type to fork. Pick from the available types."
  ),
});

export interface SubagentToolDeps {
  /** 父的 options;子代理继承 model/canUseTool/hooks/callSettings/limits。 */
  readonly options: Options;
  /** 子代理终局只取 result 文本;父的其余消息不进子代理。 */
  readonly parentPrompt: readonly import("ai").ModelMessage[];
}

/** 递归跑一个子代理:产出它的全部消息(parent_tool_use_id 挂在每条上)。 */
export async function* runSubagentQuery(
  deps: SubagentToolDeps,
  input: {
    readonly subagentType: string;
    readonly definition: AgentDefinition;
    readonly prompt: string;
    readonly parentToolUseID: string;
    readonly abortSignal: AbortSignal;
  },
): AsyncGenerator<HarnessMessage> {
  const allowed = new Set(input.definition.tools ?? []);
  const childTools = (deps.options.tools ?? []).filter(
    (t) => allowed.size === 0 || allowed.has(t.name),
  );

  const child = query({
    prompt: [
      ...deps.parentPrompt,
      { role: "system" as const, content: input.definition.prompt },
      { role: "user" as const, content: input.prompt },
    ],
    options: {
      model: input.definition.model ?? deps.options.model,
      systemPrompt: input.definition.prompt,
      tools: childTools,
      maxTurns: input.definition.maxTurns ?? 50,
      // 同一实例:子代理的权限走同一条链(agentID = 子代理名)。
      ...(deps.options.canUseTool !== undefined
        ? { canUseTool: deps.options.canUseTool }
        : {}),
      ...(deps.options.hooks !== undefined ? { hooks: deps.options.hooks } : {}),
      ...(deps.options.callSettings !== undefined
        ? { callSettings: deps.options.callSettings }
        : {}),
      ...(deps.options.limits !== undefined ? { limits: deps.options.limits } : {}),
      abortController: abortControllerFor(input.abortSignal),
    },
  });

  for await (const message of child) {
    yield stampParent(message, input.parentToolUseID);
  }
}

/** 把消息的 parent_tool_use_id 换成派发它的那次调用(原值只属于子代理自己嵌套)。 */
const stampParent = (
  message: HarnessMessage,
  parentToolUseID: string,
): HarnessMessage => ({
  ...message,
  parent_tool_use_id: parentToolUseID,
});

/** 由父信号驱动的 AbortController:父 abort → 子 abort(单向)。 */
const abortControllerFor = (signal: AbortSignal): AbortController => {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller;
};

/** 注册进父 tools 的 subagent 工具定义;agents 为空时返回 undefined(不注册)。 */
export function createSubagentToolDefinition(
  deps: SubagentToolDeps,
): ToolDefinition | undefined {
  const agents = deps.options.agents;
  if (agents === undefined || Object.keys(agents).length === 0) return undefined;
  const descriptions = Object.entries(agents)
    .map(([type, def]) => `- ${type}: ${def.description}`)
    .join("\n");

  return tool({
    name: "subagent",
    description: [
      "Delegate a self-contained task to a subagent (a separate agent that works in its own " +
      "context) to offload focused, independent work — research, a scoped analysis — so it does " +
      "not consume this conversation's context.",
      "The subagent returns its result, not its intermediate steps. Give it a complete, " +
      "standalone prompt: it does not see this conversation.",
      "Available types:",
      descriptions,
    ].join("\n"),
    inputSchema: subagentSchema,
    execute: async (input, extra) => {
      const definition = agents[input.subagent];
      if (definition === undefined) {
        return {
          content: [{
            type: "text",
            text: `Error: Unknown subagent type: ${input.subagent}. Available: ${Object.keys(agents).join(", ")}.`,
          }],
          isError: true,
        };
      }

      let text = "";
      for await (const message of runSubagentQuery(deps, {
        subagentType: input.subagent,
        definition,
        prompt: input.prompt,
        parentToolUseID: extra.toolUseID,
        abortSignal: extra.signal,
      })) {
        if (message.type === "result") {
          text =
            message.subtype === "success" ? message.result : `Error: subagent failed.`;
        }
      }
      return textResult(textOf({ content: [{ type: "text", text }] }));
    },
  });
}
