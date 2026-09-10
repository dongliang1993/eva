import type { ModelMessage, SystemModelMessage } from "ai";
import type {
  RunAgentStreamEvent,
  StreamFinishReason,
  StreamTokenUsage,
} from "@eva/shared";

import type { ContextWindowPolicyOptions } from "../context/policy.js";
import type { AgentModel } from "../models/agent-model.js";
import type { AgentTool, PlanGateState } from "../tools/index.js";
import type { AgentObserver } from "./observer.js";

export type ToolExecutionEvent =
  | { type: "started"; toolCallId: string; toolName: string; input: unknown }
  | { type: "completed"; toolCallId: string; output: unknown }
  | { type: "failed"; toolCallId: string; error: string };

export interface AgentRunInput {
  onToolExecution?: ((event: ToolExecutionEvent) => void) | undefined;
  messages: ModelMessage[];
  context?: Record<string, unknown>;
  maxSteps?: number;
  additionalTools?: AgentTool[];
  /**
   * T39/T43:显式选定本轮生效的工具名(白名单)。设了就照单过滤、绕过数量安全网
   * (显式选择优先);不设 = 走 resolveToolExposure,>40 进 discovery mode
   * (首步 core + tool_search,搜索激活后下一 step 可用)。
   */
  activeToolNames?: readonly string[];
  /**
   * T44:skill allowed-tools 的「合并」名单(不是显式白名单)。<=40 时全集本来就可用,
   * 它不改变行为;>40 进 discovery mode 时并入首步 active(core ∪ preferred,仍受 40 上限)。
   */
  preferredToolNames?: readonly string[];
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
  /** T50:真实执行时长(三段计时;无审批无排队时两个等待字段为 0 —— 0 是「没等」)。 */
  toolExecMs?: number;
  /** T50:审批等待。 */
  approvalWaitMs?: number;
  /** T50:并发帽排队等待。 */
  queueWaitMs?: number;
      /** T50:执行观察到 abort 并协作退出。 */
  execAborted?: boolean;
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

/** 危险工具执行前的用户审批入口；缺省时拒绝执行。 */
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
   * T25:SDK TimeoutConfiguration 的工具子集 —— streamText 的
   * `timeout: { toolMs, tools: { <toolName>Ms } }`。SDK 把超时折成
   * AbortSignal 塞进 `options.abortSignal` 传给工具 execute(它从不自己
   * 杀工具),工具实现必须观察 signal 并协作退出。不传 = 不配超时(现状),
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
   * 模型身份只用于把 reactive context overflow 诊断事件关联到实际路由结果。
   */
  modelIdentity?: { providerId: string; modelId: string };
  /** T45a:run-scoped plan gate 状态。传了就在最外层包 withPlanGate + 每步注 reminder。 */
  planGateState?: PlanGateState;
}
