/**
 * Harness 公开类型的家 —— 字段名与语义照 Claude Agent SDK
 * (https://code.claude.com/docs/zh-CN/agent-sdk/typescript) 同名同义。
 *
 * 本文件只放**工具形状**相关的类型（001-harness-sdk-shape 的契约原样）。
 * 权限 / hooks / 消息输出 / Options 留在后续任务逐批落地,不提前放。
 */

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
