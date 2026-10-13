import { Semaphore } from "../tools/concurrency-cap.js";
import { aborted, errorResultFrom, textOf } from "../tools/tool.js";
import type { PipelineTool } from "../tools/tool.js";
import {
  runPostToolUse,
  runPostToolUseFailure,
  runPreToolUse,
} from "./hooks.js";
import { evaluatePermission } from "./permission.js";
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  ToolResult,
} from "./types.js";
import type { ToolExtra } from "./types.js";

/**
 * 一次工具调用 = 一个函数。按顺序写完整个生命周期(替代包装器链):
 *
 *   signal.throwIfAborted()
 *   PreToolUse hooks          → 任一 deny:结果 = deny 文案,跳过后面全部,不触发 Post hooks
 *   evaluatePermission()      → 计时 approval_wait_ms
 *     deny                    → 结果 = textResult(message) 或 errorResult(message);interrupt 记进 turn 状态
 *     allow                   → input = updatedInput ?? input
 *   readOnly ? 等并发位        → 计时 queue_wait_ms
 *   execute(input, extra)     → 计时 exec_ms;抛错兜底成 errorResult
 *   PostToolUse / PostToolUseFailure hooks(isError 或抛错走 Failure;abort 时 is_interrupt=true)
 *   return ToolResult
 *
 * 三段计时存在调用方传入的 Map 里:UserMessage.tool_timing 从这里取。
 * hooks 失败 = 本次工具调用失败(execute 之前)或收口失败(execute 之后),
 * 与今天台账写库失败会让工具失败的语义一致 —— intent 没写进去就不能执行。
 */

/**
 * 三段计时的 run 内可变形状。契约 ToolTiming 是它的对外只读视图
 * (UserMessage.tool_timing 直接消费);计时期间在这里累加,发消息前不再改。
 */
export interface ToolTimingMutable {
  approval_wait_ms: number;
  queue_wait_ms: number;
  exec_ms: number;
  aborted: boolean;
}

export interface ToolCallHooks {
  readonly hooks: Partial<Record<HookEvent, readonly HookCallbackMatcher[]>>;
}

export interface ToolCallContext extends ToolCallHooks {
  readonly canUseTool: CanUseTool | undefined;
  readonly readOnlyLimiter: Semaphore;
  /** 三段计时的汇聚点;key = toolUseID。 */
  readonly timings: Map<string, ToolTimingMutable>;
  /** 子代理调用带它(= taskId);主 agent 不带。 */
  readonly agentID?: string;
}

export interface ToolCallResult {
  readonly result: ToolResult;
  /** deny.interrupt === true:本步工具收口后结束本轮。 */
  readonly interruptTurn: boolean;
}

const newTiming = (): ToolTimingMutable => ({
  approval_wait_ms: 0,
  queue_wait_ms: 0,
  exec_ms: 0,
  aborted: false,
});

const timingOf = (ctx: ToolCallContext, toolUseID: string): ToolTimingMutable => {
  const existing = ctx.timings.get(toolUseID);
  if (existing !== undefined) return existing;
  const created = newTiming();
  ctx.timings.set(toolUseID, created);
  return created;
};

/** deny 的结果形态:isError ? 带 Error: 前缀(幂等,不双拼) : 原样文本。 */
const denyResult = (message: string, isError: boolean): ToolResult => {
  if (!isError) return { content: [{ type: "text", text: message }] };
  // server 侧文案可能已带前缀(reject 分支沿用今天的完整句子);前缀幂等,不双拼。
  const text = message.startsWith("Error: ") ? message : `Error: ${message}`;
  return { content: [{ type: "text", text }], isError: true };
};

/** 一次工具调用的完整生命周期。不抛:一切失败都折叠成 isError 结果。 */
export const runToolCall = async (
  tool: PipelineTool,
  rawInput: Record<string, unknown>,
  extra: ToolExtra,
  ctx: ToolCallContext,
): Promise<ToolCallResult> => {
  const timing = timingOf(ctx, extra.toolUseID);
  const hookArgs = {
    toolName: tool.name,
    toolInput: rawInput,
    toolUseID: extra.toolUseID,
    ...(ctx.agentID !== undefined ? { agentID: ctx.agentID } : {}),
    signal: extra.signal,
  };

  // 入参 signal 已 abort:直接收口(aborted()),不进 hook / 权限 / execute。
  if (extra.signal.aborted) {
    return { result: aborted(), interruptTurn: false };
  }

  // ① PreToolUse hooks。任一 deny:结果 = deny 文案,后面全部跳过(权限、并发位、execute、Post hooks 都不碰)。
  let preDeny: { readonly message: string } | undefined;
  try {
    const outcome = await runPreToolUse({
      ...hookArgs,
      hooks: ctx.hooks.PreToolUse ?? [],
    });
    if (outcome.denied) {
      preDeny = { message: outcome.message ?? "Denied by PreToolUse hook." };
    }
  } catch (error) {
    return {
      result: failBeforeExecute(timing, error, extra, ctx, tool, rawInput),
      interruptTurn: false,
    };
  }
  if (preDeny !== undefined) {
    // hook deny 不算故障(isError=false):这是进程所有者的策略决定,不是工具坏了。
    timing.approval_wait_ms = 0;
    return {
      result: denyResult(preDeny.message, false),
      interruptTurn: false,
    };
  }

  // ② 权限评估(计时 approval_wait_ms)。
  const permissionStart = Date.now();
  let permission;
  try {
    permission = await evaluatePermission({
      toolName: tool.name,
      toolInput: rawInput,
      annotations: tool.annotations,
      canUseTool: ctx.canUseTool,
      hookDeny: undefined,
      options: {
        signal: extra.signal,
        toolUseID: extra.toolUseID,
        ...(ctx.agentID !== undefined ? { agentID: ctx.agentID } : {}),
      },
    });
  } catch (error) {
    timing.approval_wait_ms = Date.now() - permissionStart;
    return {
      result: failBeforeExecute(timing, error, extra, ctx, tool, rawInput),
      interruptTurn: false,
    };
  }
  timing.approval_wait_ms = Date.now() - permissionStart;

  if (permission.behavior === "deny") {
    // deny 的 interrupt:结果照常给模型,本轮在全部工具收口后结束(由 turn 循环读 interruptTurn)。
    return {
      result: denyResult(permission.message, permission.isError === true),
      interruptTurn: permission.interrupt === true,
    };
  }

  const input =
    permission.updatedInput !== undefined
      ? (permission.updatedInput as Record<string, unknown>)
      : rawInput;

  // ③ 只读工具等并发位(计时 queue_wait_ms)。写工具不排队(正确性由 workspace 写串行锁保证)。
  const readOnly = tool.annotations?.readOnlyHint === true;
  if (readOnly) {
    const queueStart = Date.now();
    let release: () => void;
    try {
      release = await ctx.readOnlyLimiter.acquire(extra.signal);
    } catch (error) {
      // 排队中被 abort:进 Failure,不进 execute。
      return {
        result: failBeforeExecute(timing, error, extra, ctx, tool, input),
        interruptTurn: false,
      };
    }
    timing.queue_wait_ms = Date.now() - queueStart;
    try {
      return await executeWithTiming(tool, input, extra, ctx, timing);
    } finally {
      release();
    }
  }

  return executeWithTiming(tool, input, extra, ctx, timing);
};

/** execute + exec 计时 + Post hooks。 */
const executeWithTiming = async (
  tool: PipelineTool,
  input: Record<string, unknown>,
  extra: ToolExtra,
  ctx: ToolCallContext,
  timing: ToolTimingMutable,
): Promise<ToolCallResult> => {
  const execStart = Date.now();
  let result: ToolResult;
  try {
    result = await tool.execute(input, extra);
  } catch (error) {
    timing.exec_ms = Date.now() - execStart;
    timing.aborted = extra.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    await runPostToolUseFailure({
      hooks: ctx.hooks.PostToolUseFailure ?? [],
      toolName: tool.name,
      toolInput: input,
      error: message,
      isInterrupt: extra.signal.aborted,
      toolUseID: extra.toolUseID,
      durationMs: timing.exec_ms,
      ...(ctx.agentID !== undefined ? { agentID: ctx.agentID } : {}),
      signal: extra.signal,
    });
    return {
      result: extra.signal.aborted ? aborted() : errorResultFrom(error),
      interruptTurn: false,
    };
  }
  timing.exec_ms = Date.now() - execStart;
  timing.aborted =
    extra.signal.aborted === true &&
    result.isError === true &&
    textOf(result) === "Error: tool call aborted";

  if (result.isError === true) {
    // execute 的结构化失败(不是抛):同样走 PostToolUseFailure。
    await runPostToolUseFailure({
      hooks: ctx.hooks.PostToolUseFailure ?? [],
      toolName: tool.name,
      toolInput: input,
      error: textOf(result),
      isInterrupt: false,
      toolUseID: extra.toolUseID,
      durationMs: timing.exec_ms,
      ...(ctx.agentID !== undefined ? { agentID: ctx.agentID } : {}),
      signal: extra.signal,
    });
    return { result, interruptTurn: false };
  }

  await runPostToolUse({
    hooks: ctx.hooks.PostToolUse ?? [],
    toolName: tool.name,
    toolInput: input,
    toolResponse: result,
    toolUseID: extra.toolUseID,
    durationMs: timing.exec_ms,
    ...(ctx.agentID !== undefined ? { agentID: ctx.agentID } : {}),
    signal: extra.signal,
  });
  return { result, interruptTurn: false };
};

/** execute 之前的失败(hook 抛错 / 权限评估抛错 / 排队 abort):进 PostToolUseFailure,返回 errorResult。 */
const failBeforeExecute = (
  timing: ToolTimingMutable,
  error: unknown,
  extra: ToolExtra,
  ctx: ToolCallContext,
  tool: PipelineTool,
  input: Record<string, unknown>,
): ToolResult => {
  const message = error instanceof Error ? error.message : String(error);
  // 异步收口:失败路径不能再抛;hook 观察者失败静默(runPostToolUseFailure 内部已吞)。
  void runPostToolUseFailure({
    hooks: ctx.hooks.PostToolUseFailure ?? [],
    toolName: tool.name,
    toolInput: input,
    error: message,
    isInterrupt: extra.signal.aborted,
    toolUseID: extra.toolUseID,
    durationMs: timing.approval_wait_ms + timing.queue_wait_ms + timing.exec_ms,
    ...(ctx.agentID !== undefined ? { agentID: ctx.agentID } : {}),
    signal: extra.signal,
  });
  return extra.signal.aborted ? aborted() : errorResultFrom(error);
};
