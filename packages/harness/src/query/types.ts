/**
 * Harness 公开类型的家 —— 字段名与语义照 Claude Agent SDK
 * (https://code.claude.com/docs/zh-CN/agent-sdk/typescript) 同名同义。
 *
 * 本文件只放**工具形状**相关的类型（001-harness-sdk-shape 的契约原样）。
 * 权限 / hooks / 消息输出 / Options 留在后续任务逐批落地,不提前放。
 */

import type { ModelMessage } from "ai";
import type { z } from "zod";

// ─────────────────────────────────────────────────────────────── 工具

/**
 * SDK 用 `tool(name, description, schema, execute, { annotations })` 建 MCP 工具。
 * Eva 用同样的字段,但直接是对象（不经过 MCP server）。
 */
export interface ToolDefinition<Input = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  /** zod（内置工具）或原样 JSON Schema（MCP 工具）。 */
  readonly inputSchema: z.ZodType<Input> | JsonSchemaInput;
  /** 同 SDK / MCP 的 ToolAnnotations。 */
  readonly annotations?: ToolAnnotations;
  /**
   * 不抛：失败返回 { isError: true }。抛了也不会炸循环 —— query 会把异常转成
   * isError 结果,但那是兜底,不是约定。abort 时返回 aborted()。
   */
  execute(input: Input, extra: ToolExtra): Promise<ToolResult>;
}

export interface JsonSchemaInput {
  readonly type: "json-schema";
  readonly schema: Record<string, unknown>;
}

export interface ToolAnnotations {
  /**
   * true：权限评估直接放行（不调 canUseTool），并受 limits.readOnlyConcurrency
   * 并发帽约束。默认 false。
   *
   * 与 SDK 的差异：SDK 让非只读工具串行执行。Eva 今天写工具不排队（正确性由
   * workspace 写串行锁 withWorkspaceWrite 保证），本次不改这个行为 ——
   * 非只读工具照旧立即执行。
   */
  readonly readOnlyHint?: boolean;
  /** 仅提示，供 canUseTool 的实现参考。默认 true（与 MCP 一致）。 */
  readonly destructiveHint?: boolean;
}

export interface ToolExtra {
  readonly toolUseID: string;
  /** 本次调用的取消信号 = run 取消 ∪ 单工具超时。execute 必须把它传给底层 I/O。 */
  readonly signal: AbortSignal;
}

/** 同 MCP CallToolResult 的子集。模型看到的是 content 里 text 的拼接。 */
export interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

// ─────────────────────────────────────────────────────────────── 权限

/** 同 SDK 签名,options 只保留 Eva 用得上的字段。 */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    readonly signal: AbortSignal;
    readonly toolUseID: string;
    /** 子代理发起的调用带它(= taskId);主 agent 不带。 */
    readonly agentID?: string;
  },
) => Promise<PermissionResult>;

/** 同 SDK。 */
export type PermissionResult =
  | {
      readonly behavior: "allow";
      /** 替换传给 execute 的 input。exit_plan_mode 用它把审批决策交给工具。 */
      readonly updatedInput?: Record<string, unknown>;
    }
  | {
      readonly behavior: "deny";
      /** 原样作为工具结果给模型。isError 为 false:拒绝不是工具故障(与今天 status=success 的行为一致)。 */
      readonly message: string;
      /** true:本步工具收口后结束本轮,result.subtype 为 "success"、result 为本轮已产出的文本。 */
      readonly interrupt?: boolean;
      /**
       * SDK 没有。true 时 message 作为 isError: true 的结果给模型(UI 显示为失败)。
       * plan gate 的 reject 用它保持今天「Error: Plan rejected…」的语义。默认 false。
       */
      readonly isError?: boolean;
    };

// ─────────────────────────────────────────────────────────────── Hooks

/** SDK 有 30+ 种;本次只实现这三种。 */
export type HookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

/** 同 SDK。matcher 是工具名的正则源串;省略 = 匹配所有。 */
export interface HookCallbackMatcher {
  readonly matcher?: string;
  readonly hooks: readonly HookCallback[];
}

/** 同 SDK 签名(第二参数 toolUseID)。必须 await 完才继续 —— intent 写库靠这一点。 */
export type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { readonly signal: AbortSignal },
) => Promise<HookJSONOutput>;

interface BaseHookInput {
  /** 子代理调用带它;主 agent 不带。同 SDK 的 agent_id。 */
  readonly agent_id?: string;
}

/** 字段名照 SDK 的 snake_case。 */
export type HookInput =
  | (BaseHookInput & {
      readonly hook_event_name: "PreToolUse";
      readonly tool_name: string;
      readonly tool_input: Record<string, unknown>;
      readonly tool_use_id: string;
    })
  | (BaseHookInput & {
      readonly hook_event_name: "PostToolUse";
      readonly tool_name: string;
      readonly tool_input: Record<string, unknown>;
      readonly tool_response: ToolResult;
      readonly tool_use_id: string;
      readonly duration_ms: number;
    })
  | (BaseHookInput & {
      readonly hook_event_name: "PostToolUseFailure";
      readonly tool_name: string;
      readonly tool_input: Record<string, unknown>;
      readonly tool_use_id: string;
      readonly error: string;
      /** 同 SDK:因 abort 结束。 */
      readonly is_interrupt: boolean;
      readonly duration_ms: number;
    });

/** SDK SyncHookJSONOutput 的子集。只有 PreToolUse 的 deny 有效果,其余返回 {} 即可。 */
export interface HookJSONOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision?: "deny";
    readonly permissionDecisionReason?: string;
  };
}

// ─────────────────────────────────────────────────────────────── 输出

/**
 * 同 SDK 的 SDKMessage 命名与判别方式（type + subtype）。字段收敛到 Eva 用得上的。
 *
 * 顺序保证（一次模型调用 = 一个 turn）：
 *   system/init →
 *   [ stream_event(step_start) → (stream_event)* → (assistant)+ → system/turn_complete → (user)? ]* →
 *   result
 *
 * 与 SDK 一致：**每个内容块完成时发一条 assistant**（一段文本、一段推理、一个工具调用各一条），
 * 不等整次模型调用结束。这是硬要求 —— 工具在它的 tool-call 块到达时就开始执行（canUseTool 会发审批帧），
 * 所以 tool-call 的 assistant 消息必须先于审批发生。
 *
 * user 是这次模型调用全部工具的结果（一条消息装全部结果），在全部工具收口后发。
 * 每条消息有 parent_tool_use_id：子代理的消息带上派发它的那次 subagent 调用的 id，主 agent 为 null。
 */
export type HarnessMessage =
  | SystemInitMessage
  | StreamEventMessage
  | AssistantMessage
  | TurnCompleteMessage
  | UserMessage
  | CompactBoundaryMessage
  | ResultMessage;

export interface SystemInitMessage {
  readonly type: "system";
  readonly subtype: "init";
  readonly model: string;
  readonly tools: readonly string[];
  /** 真实发给模型的 system prompt（含 dynamicInstructions 的首次取值）。轨迹页的 request_snapshot 用它。 */
  readonly system_prompt: string;
  readonly parent_tool_use_id: string | null;
}

export interface StreamEventMessage {
  readonly type: "stream_event";
  readonly event: StreamDelta;
  readonly parent_tool_use_id: string | null;
}

/**
 * SDK 这里是 Anthropic 原始流事件；Eva 用 provider 无关的增量。text/reasoning 已按 STREAM_COALESCE_WINDOW_MS 合并。
 *
 * step_start 不受 includePartialMessages 控制，恒发：每次模型调用开始时一次（含第一次），先于这次调用的任何其他消息。
 * 前端靠它在文本到达前分段；轨迹页靠它记 step_started。
 */
export type StreamDelta =
  | { readonly type: "step_start"; readonly turn: number }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "reasoning_delta"; readonly text: string }
  | { readonly type: "tool_input_start"; readonly tool_use_id: string; readonly tool_name: string }
  | { readonly type: "tool_input_delta"; readonly tool_use_id: string; readonly delta: string };

export interface AssistantMessage {
  readonly type: "assistant";
  /** AI SDK 的 AssistantModelMessage，content 恰好一个 part：text / reasoning / tool-call。 */
  readonly message: Extract<ModelMessage, { role: "assistant" }>;
  /** 本次模型调用序号，从 0 起。同一 turn 的多条 assistant 共享它（SDK 里是共享 message id）。 */
  readonly turn: number;
  readonly parent_tool_use_id: string | null;
}

/**
 * SDK 没有：SDK 把用量挂在每条 assistant 上。Eva 按内容块拆消息后，一次模型调用的用量与耗时
 * 只能在调用结束时给出，所以单独一条。轨迹页的 step_completed / model_call_completed 来自这里。
 */
export interface TurnCompleteMessage {
  readonly type: "system";
  readonly subtype: "turn_complete";
  readonly turn: number;
  readonly usage: TokenUsage;
  /** 发请求到第一个 token。模型一个 token 都没出就结束时为 null。 */
  readonly ttft_ms: number | null;
  readonly duration_ms: number;
  /** AI SDK 的 finishReason（"stop" / "length" / "tool-calls" / …）。 */
  readonly stop_reason: string;
  readonly parent_tool_use_id: string | null;
}

export interface UserMessage {
  readonly type: "user";
  /** AI SDK 的 ToolModelMessage：本次模型调用的全部工具结果。 */
  readonly message: Extract<ModelMessage, { role: "tool" }>;
  readonly turn: number;
  /** 每个工具调用的三段计时，按 tool_use_id 索引。 */
  readonly tool_timing: Readonly<Record<string, ToolTiming>>;
  readonly parent_tool_use_id: string | null;
}

export interface ToolTiming {
  readonly approval_wait_ms: number;
  readonly queue_wait_ms: number;
  readonly exec_ms: number;
  /** execute 观察到 abort 并协作退出。 */
  readonly aborted: boolean;
}

export interface CompactBoundaryMessage {
  readonly type: "system";
  readonly subtype: "compact_boundary";
  readonly trigger: "auto" | "overflow_retry";
  readonly pre_tokens: number;
  readonly post_tokens: number;
  readonly pre_messages: number;
  readonly post_messages: number;
  readonly parent_tool_use_id: string | null;
}

/** 同 SDK 的 result 消息：subtype 判别成败。迭代结束前恒最后一条。 */
export type ResultMessage =
  | (ResultBase & { readonly subtype: "success"; readonly result: string })
  | (ResultBase & {
      readonly subtype: "error_max_turns" | "error_during_execution" | "interrupted";
      readonly errors: readonly string[];
      /** error_during_execution 时：失败发生在哪一层。 */
      readonly failure_layer?: "context" | "model";
    });

interface ResultBase {
  readonly type: "result";
  readonly num_turns: number;
  readonly duration_ms: number;
  readonly usage: TokenUsage;
  /** 模型最后一次的 finish reason（"stop" / "length" / "tool-calls" / …），没有则 null。 */
  readonly stop_reason: string | null;
  readonly parent_tool_use_id: string | null;
}

export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly reasoning_tokens?: number;
}
