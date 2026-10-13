import type { ModelMessage, SystemModelMessage } from "ai";
import type {
  StreamFinishReason,
  StreamTokenUsage,
} from "@eva/shared";

import type { HarnessMessage } from "../query/types.js";

import type { ContextWindowPolicyOptions } from "../context/policy.js";
import type { AgentModel } from "../models/agent-model.js";
import type { PipelineTool } from "../tools/index.js";
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
} from "../query/types.js";
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
  additionalTools?: readonly PipelineTool[];
  /** 子代理 run 带它(= taskId);主 agent 不带。进 canUseTool 的 options.agentID。 */
  agentID?: string;
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

export interface Agent {
  /** 流式输出:一条 HarnessMessage 流(SSE 帧与轨迹页都从它翻)。 */
  stream(input: AgentRunInput): AsyncGenerator<HarnessMessage>;
}

/** SSE 帧域的旧别名(shared 的 RunAgentStreamEvent);T3 收尾随 observer-bridge 删。 */
export type AgentStreamEvent = import("@eva/shared").RunAgentStreamEvent;

/** 每次模型调用的 call settings(AI SDK 语义:不属于 model 实例,属于调用)。 */
export interface AgentCallSettings {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface CreateAgentOptions {
  model: AgentModel;
  tools?: readonly PipelineTool[];
  systemPrompt?: string | SystemModelMessage;
  maxSteps?: number;
  observer?: AgentObserver;
  contextPolicy?: ContextWindowPolicyOptions;
  /** 唯一权限入口(FR-003);未提供时走到 canUseTool 的调用全 deny。 */
  canUseTool?: CanUseTool;
  /** 每步注入、不进历史的 system 段;每次调模型前读一次。plan mode 的提醒走这里。 */
  dynamicInstructions?: () => readonly string[];
  hooks?: Partial<Record<HookEvent, readonly HookCallbackMatcher[]>>;
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
}
