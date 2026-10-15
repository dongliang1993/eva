import { z } from "zod";

import { errorResult, textResult, tool } from "../tools/tool.js";
import { runQuery } from "./query.js";
import { taskNotificationMessage, taskStartedMessage } from "./messages.js";
import type { SideChannel } from "./side-channel.js";
import type {
  AgentDefinition,
  HarnessMessage,
  Options,
  ResultMessage,
  ToolDefinition,
} from "./types.js";

/**
 * 内置 subagent 工具(Claude Code 的 Agent 工具同款):
 *
 * - 定义来自 options.agents;为空时不注册。工具说明由定义拼出。
 * - 子代理是全新上下文:prompt = [user: 任务],system = 定义的 prompt(不继承父对话)。
 * - 工具:父的 tools → tools 白名单 → disallowedTools 剔除;subagent 自身恒不给(防递归)。
 * - 身份:每次派发一个 agentID,经 canUseTool / hooks 的 agentID 透传(同 SDK 的 agent_id)。
 * - abort:父信号单向驱动子代理。
 * - 消息:task_started → 子代理全部消息(parent_tool_use_id = 派发调用)→ task_notification,
 *   经旁路通道并入父 query() 的流。
 * - 结果:子代理 result 文本回给父;失败 / 中断 / 超步是 isError 结果(带原因)。
 */

export const SUBAGENT_TOOL_NAME = "subagent";
const DEFAULT_SUBAGENT_MAX_TURNS = 50;

const subagentSchema = z.object({
  description: z.string().min(1).describe(
    "A short (3-5 word) description of the delegated task, for display."
  ),
  prompt: z.string().min(1).describe(
    "The complete, self-contained task for the subagent. It does not share this " +
    "conversation's context, so include everything it needs."
  ),
  subagent: z.string().min(1).optional().describe(
    "Subagent type to fork. Pick from the available types; defaults to the first one."
  ),
});

export interface SubagentToolDeps {
  /** 父的 options;子代理继承 model/tools/canUseTool/hooks/callSettings/limits。 */
  readonly options: Options;
  /** 父 query() 的旁路:子代理消息并入父流。 */
  readonly channel: SideChannel<HarnessMessage>;
  /** 派发 id 生成器(测试注入确定值)。 */
  readonly newAgentID?: () => string;
}

/** 子代理能拿到的工具:父工具 → 白名单 → 黑名单;subagent 自身恒排除。 */
export const resolveSubagentTools = (
  parentTools: readonly ToolDefinition[],
  definition: AgentDefinition,
): readonly ToolDefinition[] => {
  const allowed = definition.tools === undefined ? undefined : new Set(definition.tools);
  const disallowed = new Set(definition.disallowedTools ?? []);
  return parentTools.filter((t) =>
    t.name !== SUBAGENT_TOOL_NAME &&
    (allowed === undefined || allowed.has(t.name)) &&
    !disallowed.has(t.name));
};

/** 父信号单向驱动的子 AbortController。 */
const linkedAbortController = (signal: AbortSignal): AbortController => {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller;
};

/** 子代理的 Options:全新上下文 + 父的权限链 / hooks(同一实例,agentID 区分)。 */
const childOptions = (
  parent: Options,
  definition: AgentDefinition,
  abortController: AbortController,
): Options => ({
  model: definition.model ?? parent.model,
  systemPrompt: definition.prompt,
  tools: resolveSubagentTools(parent.tools ?? [], definition),
  maxTurns: definition.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
  abortController,
  ...(parent.includePartialMessages !== undefined
    ? { includePartialMessages: parent.includePartialMessages }
    : {}),
  ...(parent.canUseTool !== undefined ? { canUseTool: parent.canUseTool } : {}),
  ...(parent.hooks !== undefined ? { hooks: parent.hooks } : {}),
  ...childCallSettings(parent, definition),
  ...(parent.limits !== undefined ? { limits: parent.limits } : {}),
});

/**
 * call settings 继承 temperature;maxOutputTokens 属于父模型 —— 子代理换了模型时不带
 * (子模型自己的输出上限在它的 ModelBinding.maxOutputTokens 里)。
 */
const childCallSettings = (
  parent: Options,
  definition: AgentDefinition,
): Pick<Options, "callSettings"> => {
  const settings = parent.callSettings;
  if (settings === undefined) return {};
  if (definition.model === undefined) return { callSettings: settings };
  return settings.temperature !== undefined
    ? { callSettings: { temperature: settings.temperature } }
    : {};
};

/** 子代理终局 → (回给父的文本, task 状态)。 */
const outcomeOf = (
  result: ResultMessage | undefined,
): { readonly status: "completed" | "failed" | "stopped"; readonly summary: string } => {
  if (result === undefined) {
    return { status: "failed", summary: "Subagent stream ended without a terminal outcome." };
  }
  switch (result.subtype) {
    case "success":
      return { status: "completed", summary: result.result };
    case "interrupted":
      return { status: "stopped", summary: "Subagent was interrupted." };
    case "error_max_turns":
      return { status: "failed", summary: result.errors[0] ?? "Subagent reached its turn limit." };
    case "error_during_execution":
      return { status: "failed", summary: result.errors[0] ?? "Subagent failed." };
  }
};

/** 注册进父 tools 的 subagent 工具定义;agents 为空时返回 undefined(不注册)。 */
export function createSubagentToolDefinition(
  deps: SubagentToolDeps,
): ToolDefinition | undefined {
  const agents = deps.options.agents;
  if (agents === undefined || Object.keys(agents).length === 0) return undefined;
  const newAgentID = deps.newAgentID ?? (() => `a${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`);
  const descriptions = Object.entries(agents)
    .map(([type, def]) => `- ${type}: ${def.description}`)
    .join("\n");

  return tool({
    name: SUBAGENT_TOOL_NAME,
    description: [
      "Delegate a self-contained task to a subagent (a separate agent that works in its own " +
      "context) to offload focused, independent work — research, a scoped analysis — so it does " +
      "not consume this conversation's context.",
      "The subagent returns its result, not its intermediate steps. Give it a complete, " +
      "standalone prompt: it does not see this conversation.",
      "The tool waits for the subagent and returns its final result. Independent calls may run in parallel.",
      "Available types:",
      descriptions,
    ].join("\n"),
    inputSchema: subagentSchema,
    execute: async (input, extra) => {
      // 省略类型 = 第一个定义(Claude Code 省略 subagent_type 时落 general-purpose 同理)。
      const subagentType = input.subagent ?? Object.keys(agents)[0]!;
      const definition = agents[subagentType];
      if (definition === undefined) {
        return errorResult(
          `Unknown subagent type: ${subagentType}. Available: ${Object.keys(agents).join(", ")}.`,
        );
      }

      const agentID = newAgentID();
      const stamp = (message: HarnessMessage): HarnessMessage => ({
        ...message,
        parent_tool_use_id: extra.toolUseID,
      });
      deps.channel.push(taskStartedMessage({
        taskId: agentID,
        toolUseID: extra.toolUseID,
        description: input.description,
        taskType: subagentType,
        prompt: input.prompt,
        parentToolUseID: null,
      }));

      let result: ResultMessage | undefined;
      try {
        const child = runQuery(
          {
            prompt: [{ role: "user", content: input.prompt }],
            options: childOptions(deps.options, definition, linkedAbortController(extra.signal)),
          },
          { agentID },
        );
        for await (const message of child) {
          if (message.type === "result") result = message;
          deps.channel.push(stamp(message));
        }
      } catch (error) {
        // 子代理装配期失败(工具名冲突等):收口成 failed,不炸父循环。
        result = {
          type: "result",
          subtype: "error_during_execution",
          errors: [error instanceof Error ? error.message : String(error)],
          num_turns: 0,
          duration_ms: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: null,
          parent_tool_use_id: extra.toolUseID,
        };
      }

      const outcome = outcomeOf(result);
      deps.channel.push(taskNotificationMessage({
        taskId: agentID,
        toolUseID: extra.toolUseID,
        status: outcome.status,
        summary: outcome.summary,
        parentToolUseID: null,
      }));
      return outcome.status === "completed"
        ? textResult(outcome.summary || "(Subagent completed but returned no output.)")
        : errorResult(outcome.summary);
    },
  });
}
