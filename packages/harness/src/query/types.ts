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
