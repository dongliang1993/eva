import type { BaseMessageLike, SystemMessage } from "@langchain/core/messages";

import type { ContextWindowPolicyOptions } from "../context/policy.js";
import type { AgentModel } from "../models/agent-model.js";
import type { SubagentConfig } from "../subagents/types.js";
import type { AgentTool } from "../tools.js";
import type { AgentObserver } from "./observer.js";

export interface AgentRunInput {
  messages: BaseMessageLike[];
  context?: Record<string, unknown>;
  maxSteps?: number;
  additionalTools?: AgentTool[];
}

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

export type AgentStreamEvent =
  | { type: "text_chunk"; content: string }
  | {
      type: "tool_call_start";
      toolName: string;
      toolCallId: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_call_end";
      toolName: string;
      toolCallId: string;
      output: string;
      status: "success" | "error";
    }
  | { type: "result"; text: string; toolCalls: AgentToolCallResult[] }
  | { type: "error"; message: string };

export interface Agent {
  invoke(input: AgentRunInput): Promise<AgentRunResult>;
  stream(input: AgentRunInput): AsyncIterable<AgentStreamEvent>;
}

export interface CreateAgentOptions {
  model: AgentModel;
  tools?: AgentTool[];
  systemPrompt?: string | SystemMessage;
  maxSteps?: number;
  subagents?: SubagentConfig[];
  observer?: AgentObserver;
  contextPolicy?: ContextWindowPolicyOptions;
}
