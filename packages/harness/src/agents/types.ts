import type { ModelMessage, SystemModelMessage } from "ai";
import type {
  RunAgentStreamEvent,
  RunInjectedNotice,
  StreamFinishReason,
  StreamTokenUsage,
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
  drainNotices?: (opts: {
    graceMs: number;
  }) => Promise<readonly RunInjectedNotice[]>;
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
export type RequestApproval = (
  request: ToolApprovalRequest,
) => Promise<boolean>;

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
  /**
   * T25:SDK TimeoutConfiguration 的工具子集 —— streamText 的
   * `timeout: { toolMs, tools: { <toolName>Ms } }`。SDK 把超时折成
   * AbortSignal 塞进 `options.abortSignal` 传给工具 execute(它从不自己
   * 杀工具),真正收口靠 build-tool 的 race 兜底。不传 = 不配超时(现状),
   * 默认值由 server 的 agent-factory 注入 —— harness 的最小使用者不该被
   * 强加隐形的 60s 行为。类型故意不复用 SDK 全集(totalMs/stepMs/chunkMs
   * 明确不做,r6 00-overview §2.1 #4)。
   */
  toolTimeout?: { toolMs: number; tools?: Record<string, number> };
  /**
   * T24:只读工具的并发上限(每 agent 实例)。SDK 对一步内的 tool calls 是
   * Promise.all 全量并发 —— 这个帽只作用于 readOnly === true 的工具,
   * 写类直通(正确性由 T23 写守卫兜底,不该排队)。默认 10(Claude Code
   * 同款)。server 不注入,字段留给测试和将来 workspace 级配置。
   */
  readOnlyConcurrency?: number;
  /**
   * T38:reactive compact(模型因上下文超限拒单)触发时,emit
   * `context_overflow_clamp` 让 server 把这个模型的 contextWindow 钳到实测值的
   * 90% —— 登记值虚高的模型从此学会自己的真实上限。harness 不知道也不该知道
   * provider 登记处,只吐事件;钳制动作在 server 侧(deps → clampContextWindow)。
   */
  clampTarget?: { providerId: string; modelId: string };
}
