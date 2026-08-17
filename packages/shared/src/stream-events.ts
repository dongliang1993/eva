/**
 * SSE 事件契约 —— `POST /api/v1/runs/stream` 的唯一事实源（server / web / harness 共用）。
 *
 * 设计依据 docs/plans/s1/s1-wrapup-technical-design.md §3：
 * - AI SDK 域：事件名与 ai@7 UIMessageChunk 类型逐字对齐（kebab-case），直转 SDK chunk，不造协议；
 * - Eva 自有域：snake_case（run_start / end），仅服务端产生；
 * - 所有帧统一 `{ seq, type, ...payload }`，seq 由路由层补（harness 事件不自带 seq）。
 */

export type StreamFinishReason = "stop" | "aborted" | "error" | "max-steps";

export interface StreamTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

/** finish 帧携带的单条工具调用摘要（对齐 harness AgentToolCallResult）。 */
export interface StreamToolCallSummary {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  output: string;
  status: "success" | "error";
  durationMs?: number;
}

// ---------- AI SDK 域（harness 产生） ----------

export interface RunTextDeltaEvent {
  type: "text-delta";
  textDelta: string;
}

export interface RunReasoningDeltaEvent {
  type: "reasoning-delta";
  textDelta: string;
}

export interface RunToolInputStartEvent {
  type: "tool-input-start";
  toolCallId: string;
  toolName: string;
}

export interface RunToolInputDeltaEvent {
  type: "tool-input-delta";
  toolCallId: string;
  delta: string;
}

export interface RunToolCallEvent {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface RunToolResultEvent {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: string;
  status: "success" | "error";
  durationMs?: number;
}

export interface RunStepStartEvent {
  type: "step-start";
  step: number;
}

/** settle 帧：全量 text 为收敛点（前端不需序号/重同步通道）。 */
export interface RunFinishEvent {
  type: "finish";
  text: string;
  toolCalls: StreamToolCallSummary[];
  finishReason: StreamFinishReason;
  usage?: StreamTokenUsage;
  durationMs?: number;
}

export interface RunErrorEvent {
  type: "error";
  message: string;
}

/** harness 产出的事件（coalesce 后从 LeadAgent.stream 流出）。 */
export type RunAgentStreamEvent =
  | RunTextDeltaEvent
  | RunReasoningDeltaEvent
  | RunToolInputStartEvent
  | RunToolInputDeltaEvent
  | RunToolCallEvent
  | RunToolResultEvent
  | RunStepStartEvent
  | RunFinishEvent
  | RunErrorEvent;

// ---------- Eva 自有域（仅 server 路由产生） ----------

/** 流的第一帧：携带 abort 端点所需的 runId 与会话 id。 */
export interface RunStartEvent {
  type: "run_start";
  runId: string;
  sessionId: string;
}

/** 流的最后一帧（SSE 通道关闭信号，恒在 finish/error 之后）。 */
export interface RunEndEvent {
  type: "end";
  finishReason: StreamFinishReason;
}

export type RunStreamEvent = RunAgentStreamEvent | RunStartEvent | RunEndEvent;

/** 线上帧 = 事件 + seq；seq 单 run 内从 1 单调递增，含终态帧（accumulator 依赖此约定）。 */
export type RunStreamFrame = RunStreamEvent & { seq: number };
