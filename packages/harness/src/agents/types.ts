import type { ModelMessage, SystemModelMessage } from "ai";
import type {
  RunAgentStreamEvent,
  RunInjectedNotice,
  StreamFinishReason,
  StreamTokenUsage
} from "@eva/shared";

import type { ContextWindowPolicyOptions } from "../context/policy.js";
import type { AgentModel } from "../models/agent-model.js";
import type { AgentTool } from "../tools/index.js";
import type { AgentObserver } from "./observer.js";

export interface AgentRunInput {
  messages: ModelMessage[];
  context?: Record<string, unknown>;
  maxSteps?: number;
  additionalTools?: AgentTool[];
  abortSignal?: AbortSignal;
  /**
   * 取待注入的子代理通知(S7 push)。只在 loop 走到 stop 终态前调用一次/轮。
   *
   * 约定:无待处理通知且无存活后台任务 → 立刻返回 `[]`(不拖慢正常收尾);
   * 有存活任务但还没报 → 最多等 `graceMs`。返回非空则 loop 注入后再跑一圈。
   */
  drainNotices?: (opts: { graceMs: number }) => Promise<readonly RunInjectedNotice[]>;
}

export type { StreamFinishReason, StreamTokenUsage };

export interface AgentToolCallResult {
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
  output: string;
  status: "success" | "error";
  durationMs?: number;
}

export interface AgentRunResult {
  text: string;
  toolCalls: AgentToolCallResult[];
}

export type AgentStreamEvent = RunAgentStreamEvent;

export interface Agent {
  /**
   * 跑完整一轮并返回终态结果(内部就是把 stream 消费干)。
   * 目前只有测试在用;S7 的子代理会用它(子代理不需要流式,只要 final answer)。
   * 若 S7 落地后仍无生产调用方,那时再删。
   */
  invoke(input: AgentRunInput): Promise<AgentRunResult>;
  stream(input: AgentRunInput): AsyncIterable<AgentStreamEvent>;
}

export interface ToolApprovalRequest {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: Record<string, unknown>;
}

/** 危险工具执行前的用户审批入口(由宿主注入;默认放行)。 */
export type RequestApproval = (request: ToolApprovalRequest) => Promise<boolean>;

/** 每次模型调用的 call settings(AI SDK 语义:不属于 model 实例,属于调用)。 */
export interface AgentCallSettings {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface CreateAgentOptions {
  model: AgentModel;
  tools?: AgentTool[];
  systemPrompt?: string | SystemModelMessage;
  maxSteps?: number;
  observer?: AgentObserver;
  contextPolicy?: ContextWindowPolicyOptions;
  requestApproval?: RequestApproval;
  callSettings?: AgentCallSettings;
  /**
   * T18:repairToolCall 用的修复模型(tool 槽位)。可选 —— 不传维持 SDK 默认
   * (schema 校验失败直接报错),最小场景/测试不该被强制塞一个模型。
   */
  repairModel?: AgentModel;
}
