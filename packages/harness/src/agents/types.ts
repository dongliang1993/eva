import type { ModelMessage, SystemModelMessage } from "ai";
import type {
  RunAgentStreamEvent,
  StreamFinishReason,
  StreamTokenUsage
} from "@eva/shared";

import type { ContextWindowPolicyOptions } from "../context/policy.js";
import type { AgentModel } from "../models/agent-model.js";
import type { SubagentConfig } from "../subagents/types.js";
import type { AgentTool } from "../tools.js";
import type { AgentObserver } from "./observer.js";

export interface AgentRunInput {
  messages: ModelMessage[];
  context?: Record<string, unknown>;
  maxSteps?: number;
  additionalTools?: AgentTool[];
  abortSignal?: AbortSignal;
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
  subagents?: SubagentConfig[];
  observer?: AgentObserver;
  contextPolicy?: ContextWindowPolicyOptions;
  requestApproval?: RequestApproval;
  callSettings?: AgentCallSettings;
}
