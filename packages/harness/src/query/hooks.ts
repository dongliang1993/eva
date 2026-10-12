import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
} from "./types.js";

/**
 * hooks 的执行器:matcher 匹配 + 按注册顺序依次 await。
 *
 * 纪律:hook 必须 await 完才继续 —— intent 写库(tool_operations)靠这一点,
 * 落库没完成就不允许 execute 开始。hook 抛错往上抛给 tool-call 兜底成
 * 本次调用的失败(PostToolUseFailure),不静默吞。
 */

const matchesToolName = (matcher: string | undefined, toolName: string): boolean => {
  if (matcher === undefined || matcher === "") return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    // matcher 不是合法正则:按字面量比,不因配置笔误让 hook 静默失明。
    return matcher === toolName;
  }
};

/** 依次跑一组 hook;PostToolUse 全部跑完(结果已产生,hook 只是观察者)。 */
const runCallbacks = async (
  matchers: readonly HookCallbackMatcher[],
  makeInput: () => HookInput,
  toolUseID: string,
  signal: AbortSignal,
): Promise<void> => {
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      await hook(makeInput(), toolUseID, { signal });
    }
  }
};

export interface PreToolUseOutcome {
  /** 任一 hook 返回 deny 即 true;后面的 hook 不再跑。 */
  readonly denied: boolean;
  readonly message: string | undefined;
}

/** PreToolUse:任一 hook deny 即停(不再跑后面的 hook)。 */
export const runPreToolUse = async (input: {
  readonly hooks: readonly HookCallbackMatcher[];
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseID: string;
  readonly agentID?: string;
  readonly signal: AbortSignal;
}): Promise<PreToolUseOutcome> => {
  const matched = input.hooks.filter((matcher) =>
    matchesToolName(matcher.matcher, input.toolName),
  );
  for (const matcher of matched) {
    for (const hook of matcher.hooks) {
      const output = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: input.toolName,
          tool_input: input.toolInput,
          tool_use_id: input.toolUseID,
          ...(input.agentID !== undefined ? { agent_id: input.agentID } : {}),
        },
        input.toolUseID,
        { signal: input.signal },
      );
      if (output.hookSpecificOutput?.permissionDecision === "deny") {
        return {
          denied: true,
          message: output.hookSpecificOutput.permissionDecisionReason
            ?? "Denied by PreToolUse hook.",
        };
      }
    }
  }
  return { denied: false, message: undefined };
};

/** PostToolUse:全部跑完,失败不中断其余(结果已经产生,失败 hook 只是观察者)。 */
export const runPostToolUse = async (input: {
  readonly hooks: readonly HookCallbackMatcher[];
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolResponse: import("./types.js").ToolResult;
  readonly toolUseID: string;
  readonly durationMs: number;
  readonly agentID?: string;
  readonly signal: AbortSignal;
}): Promise<void> => {
  const matched = input.hooks.filter((matcher) =>
    matchesToolName(matcher.matcher, input.toolName),
  );
  await runCallbacks(
    matched,
    () => ({
      hook_event_name: "PostToolUse",
      tool_name: input.toolName,
      tool_input: input.toolInput,
      tool_response: input.toolResponse,
      tool_use_id: input.toolUseID,
      duration_ms: input.durationMs,
      ...(input.agentID !== undefined ? { agent_id: input.agentID } : {}),
    }),
    input.toolUseID,
    input.signal,
  );
};

/** PostToolUseFailure:hook 或 execute 抛错 / abort 收口。失败 hook 不再抛。 */
export const runPostToolUseFailure = async (input: {
  readonly hooks: readonly HookCallbackMatcher[];
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly error: string;
  readonly isInterrupt: boolean;
  readonly toolUseID: string;
  readonly durationMs: number;
  readonly agentID?: string;
  readonly signal: AbortSignal;
}): Promise<void> => {
  const matched = input.hooks.filter((matcher) =>
    matchesToolName(matcher.matcher, input.toolName),
  );
  for (const matcher of matched) {
    for (const hook of matcher.hooks) {
      try {
        await hook(
          {
            hook_event_name: "PostToolUseFailure",
            tool_name: input.toolName,
            tool_input: input.toolInput,
            tool_use_id: input.toolUseID,
            error: input.error,
            is_interrupt: input.isInterrupt,
            duration_ms: input.durationMs,
            ...(input.agentID !== undefined ? { agent_id: input.agentID } : {}),
          },
          input.toolUseID,
          { signal: input.signal },
        );
      } catch {
        // 失败 hook 只是观察者:失败报告失败,不能让收口路径再炸一次。
      }
    }
  }
};

export type { HookEvent };
