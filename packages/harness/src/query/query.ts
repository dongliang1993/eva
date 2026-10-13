import { createRunLoopAgent } from "../agents/run-loop.js";
import type { RunLoopOptions } from "../agents/run-loop.js";
import type { AgentModel } from "../models/agent-model.js";
import { buildAgentSystemPrompt } from "../prompts/prompt-builder.js";
import { createSubagentToolDefinition } from "./subagent-tool.js";
import { systemInitMessage } from "./messages.js";
import type { HarnessMessage, Options, Query } from "./types.js";

/**
 * 跑一轮 agent:校验工具名唯一 → 产出 system/init → turn 循环 → 产出 result。
 *
 * 这是 SC-001 的唯一运行入口;循环本体在 run-loop(T4 只换门面,不重写循环 ——
 * reactive compact / max-output 续写 / abort 收口都在里面,重写它们是行为回归)。
 */
const DEFAULT_MAX_TURNS = 100;

export function query(params: {
  readonly prompt: readonly import("ai").ModelMessage[];
  readonly options: Options;
}): Query {
  const { options } = params;

  // 工具名唯一:同步抛(契约)。重复名让 toolSet 静默覆盖彼此 —— 必须在入口拒绝。
  const names = new Set<string>();
  for (const tool of options.tools ?? []) {
    if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }

  const abortController = options.abortController ?? new AbortController();

  // 内置 subagent 工具:agents 为空时不注册(模型看不见它)。
  const subagentTool = createSubagentToolDefinition({
    options,
    parentPrompt: params.prompt,
  });

  const agentOptions: RunLoopOptions = {
    model: options.model.languageModel as AgentModel,
    tools: [
      ...(options.tools ?? []),
      ...(subagentTool !== undefined ? [subagentTool] : []),
    ],
    ...(options.systemPrompt !== undefined
      ? {
          systemPrompt:
            typeof options.systemPrompt === "string"
              ? options.systemPrompt
              : options.systemPrompt.join("\n\n"),
        }
      : { systemPrompt: buildAgentSystemPrompt() }),
    maxSteps: options.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(options.canUseTool !== undefined ? { canUseTool: options.canUseTool } : {}),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.callSettings !== undefined
      ? {
          callSettings: {
            ...(options.callSettings.temperature !== undefined
              ? { temperature: options.callSettings.temperature }
              : {}),
            ...(options.callSettings.maxOutputTokens !== undefined
              ? { maxOutputTokens: options.callSettings.maxOutputTokens }
              : {}),
          },
        }
      : {}),
    ...(options.limits?.toolTimeoutMs !== undefined
      ? {
          toolTimeout: {
            toolMs: options.limits.toolTimeoutMs.defaultMs,
            ...(options.limits.toolTimeoutMs.byTool !== undefined
              ? {
                  tools: Object.fromEntries(
                    Object.entries(options.limits.toolTimeoutMs.byTool),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(options.limits?.readOnlyConcurrency !== undefined
      ? { readOnlyConcurrency: options.limits.readOnlyConcurrency }
      : {}),
    ...(options.dynamicInstructions !== undefined
      ? { dynamicInstructions: options.dynamicInstructions }
      : {}),
    ...(options.model.contextWindow !== undefined ||
      options.model.maxOutputTokens !== undefined
      ? {
          contextPolicy: {
            ...(options.model.contextWindow !== undefined
              ? { contextWindow: options.model.contextWindow }
              : {}),
            ...(options.model.maxOutputTokens !== undefined
              ? { reservedOutputTokens: options.model.maxOutputTokens }
              : {}),
          },
        }
      : {}),
    modelIdentity: {
      providerId: options.model.id,
      modelId: options.model.id,
    },
  };
  const agent = createRunLoopAgent(agentOptions);

  async function* run(): AsyncGenerator<HarnessMessage> {
    // system/init 先于一切(轨迹页的 request_snapshot 靠它)。
    yield systemInitMessage({
      model: options.model.id,
      tools: [...names],
      systemPrompt:
        typeof options.systemPrompt === "string"
          ? options.systemPrompt
          : (options.systemPrompt ?? []).join("\n\n") ||
            buildAgentSystemPrompt(),
      parentToolUseID: null,
    });

    yield* agent.stream({
      messages: [...params.prompt],
      abortSignal: abortController.signal,
      ...(options.includePartialMessages !== undefined
        ? { includePartialMessages: options.includePartialMessages }
        : {}),
    });
  }

  const generator = run();
  return {
    [Symbol.asyncIterator]: () => generator,
    next: (args) => generator.next(args),
    return: (value) => generator.return(value),
    throw: (reason) => generator.throw(reason),
    [Symbol.asyncDispose]: () => generator.return(undefined).then(() => undefined),
    interrupt: async () => {
      abortController.abort();
      // 中止后驱动到底:run-loop 的 finally 会 drain 已派发的工具,随后 result(interrupted)。
      for await (const _ of generator) {
        void _;
      }
    },
  } satisfies Query;
}
