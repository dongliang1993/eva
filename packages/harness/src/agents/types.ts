import type { ModelMessage, SystemModelMessage } from "ai";

import type { ContextWindowPolicyOptions } from "../context/policy.js";
import type { AgentModel } from "../models/agent-model.js";
import type { PipelineTool } from "../tools/index.js";
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
} from "../query/types.js";

/** run-loop 的每次运行输入(query() 的 Options 字段映射到这里)。 */
export interface AgentRunInput {
  /** server 注册的 hooks(tool_operations 台账等)。 */
  hooks?:
    | Partial<Record<HookEvent, readonly HookCallbackMatcher[]>>
    | undefined;
  messages: ModelMessage[];
  maxSteps?: number;
  additionalTools?: readonly PipelineTool[];
  /** 子代理 run 带它(= taskId);主 agent 不带。进 canUseTool 的 options.agentID。 */
  agentID?: string;
  abortSignal?: AbortSignal;
  /** true 时产出 text/reasoning 的 stream_event(契约 Options.includePartialMessages)。 */
  includePartialMessages?: boolean;
}

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
  contextPolicy?: ContextWindowPolicyOptions;
  /** 唯一权限入口(FR-003);未提供时走到 canUseTool 的调用全 deny。 */
  canUseTool?: CanUseTool;
  /** 每步注入、不进历史的 system 段;每次调模型前读一次。plan mode 的提醒走这里。 */
  dynamicInstructions?: () => readonly string[];
  hooks?: Partial<Record<HookEvent, readonly HookCallbackMatcher[]>>;
  callSettings?: AgentCallSettings;
  /**
   * SDK TimeoutConfiguration 的工具子集 —— streamText 的
   * `timeout: { toolMs, tools: { <toolName>Ms } }`。SDK 把超时折成
   * AbortSignal 塞进 `options.abortSignal` 传给工具 execute(它从不自己
   * 杀工具),工具实现必须观察 signal 并协作退出。不传 = 不配超时(现状),
   * 默认值由 server 的 agent-factory 注入 —— harness 的最小使用者不该被
   * 强加隐形的 60s 行为。类型故意不复用 SDK 全集(totalMs/stepMs/chunkMs
   * 明确不做,r6 00-overview §2.1 #4)。
   */
  toolTimeout?: { toolMs: number; tools?: Record<string, number> };
  /**
   * 只读工具的并发上限(每 agent 实例)。SDK 对一步内的 tool calls 是
   * Promise.all 全量并发 —— 这个帽只作用于 readOnly === true 的工具,
   * 写类直通(正确性由 workspace 写守卫兜底,不该排队)。默认 10(Claude Code
   * 同款)。server 不注入,字段留给测试和将来 workspace 级配置。
   */
  readOnlyConcurrency?: number;
}
