/**
 * SSE 事件契约 —— `POST /api/v1/runs/stream` 的唯一事实源（server / web / harness 共用）。
 *
 * 设计依据 docs/plans/s1/s1-wrapup-technical-design.md §3：
 * - AI SDK 域：事件名与 ai@7 UIMessageChunk 类型逐字对齐（kebab-case），直转 SDK chunk，不造协议；
 * - Eva 自有域：snake_case（run_start / end），仅服务端产生；
 * - 所有帧统一 `{ seq, type, ...payload }`，seq 由 server SSE transport 补
 *   （harness 事件不自带 seq）。
 */

export type StreamFinishReason = "stop" | "aborted" | "error" | "max-steps";

export interface StreamTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  /** T40:写入 prompt cache 的 input tokens(cache 五元组之一)。 */
  cacheWriteTokens?: number;
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
  /** T51 起新事件不再赋值 —— 类型保留只为历史 UIMessage/abort 补发帧仍能解析。 */
  durationMs?: number;
  /** T50/T51:真实执行时长(不含审批/排队等待)。 */
  toolExecMs?: number;
  /** T50/T51:审批等待。 */
  approvalWaitMs?: number;
  /** T50/T51:并发帽排队等待。 */
  queueWaitMs?: number;
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

/**
 * 子代理通知已注入本轮对话（S7 push）。
 *
 * 它同时是**消息边界**信号：注入意味着「上一条 assistant 收口 → 通知作为一条
 * 主链消息 → 新起一条 assistant 续跑」，server recorder 靠这一帧切分落库
 * （见 services/runs/assistant-message-recorder.ts）。
 */
export interface RunNoticeInjectedEvent {
  type: "notice-injected";
  /** 注入给模型的通知文本（已格式化，可直接落库/渲染）。 */
  notices: readonly RunInjectedNotice[];
}

export interface RunInjectedNotice {
  readonly kind: "reported" | "settled";
  readonly taskId: string;
  readonly parentToolCallId: string;
  readonly description: string;
  readonly text: string;
}

/** harness 产出的事件（coalesce 后从 Agent.stream 流出）。 */
export type RunAgentStreamEvent =
  | RunTextDeltaEvent
  | RunReasoningDeltaEvent
  | RunToolInputStartEvent
  | RunToolInputDeltaEvent
  | RunToolCallEvent
  | RunToolResultEvent
  | RunStepStartEvent
  | RunNoticeInjectedEvent
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

// ---------- Eva 自有域：审批桥（docs 14 §6.1） ----------

/** 危险工具调用的风险画像(T14)。 */
export type ToolRiskLevel = "normal" | "elevated" | "destructive";

export interface ToolRisk {
  readonly level: ToolRiskLevel;
  /** 命中的原因，直接展示给用户（如 "递归强制删除"、"覆盖写入到文件"）。 */
  readonly reasons: readonly string[];
}

/** 危险工具挂起等待用户决策。 */
export interface RunApprovalRequestEvent {
  type: "approval_request";
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** T14：本次调用的风险画像，前端据此配色/标注/决定是否给「始终允许」。 */
  risk: ToolRisk;
}

/**
 * T30:一次审批的决策(落进消息 part 的 toolMetadata,随历史持久)。
 * decidedAt 与 approval_requests.decidedAt 同源(ISO)。
 */
export interface ApprovalDecision {
  readonly action: "granted" | "denied";
  readonly decidedAt: string;
}

/** 审批已决（用户决策 / 自动放行 / abort 取消）。 */
export interface RunApprovalResolvedEvent {
  type: "approval_resolved";
  callId: string;
  approved: boolean;
  /** T30:决策定格态 —— 前端卡片据此定格成「已允许/已拒绝 · 时间」。 */
  decision: ApprovalDecision;
}

export type RunApprovalEvent = RunApprovalRequestEvent | RunApprovalResolvedEvent;

// ---------- T45b:plan review 平行决策通道（不动普通工具的 boolean 协议） ----------

export const planReviewOutcomes = [
  "approve",
  "revise",
  "reject",
  "reject_and_exit",
  "dismissed"
] as const;

export type PlanReviewOutcome = (typeof planReviewOutcomes)[number];

/** plan review 的结构化决策。feedback 是用户原文,不摘要/不改写/不截断。 */
export interface PlanReviewDecision {
  readonly outcome: PlanReviewOutcome;
  /** revise 必填;reject 可选。 */
  readonly feedback?: string;
  /** approve 且用户选了 option 时。 */
  readonly selectedLabel?: string;
  readonly decidedAt: string;
}

export interface PlanReviewOptionView {
  readonly label: string;
  readonly description: string;
}

/** exit_plan_mode 挂起等待 plan review 决策。planMarkdown 直接带正文,前端不必再拉文件。 */
export interface RunPlanReviewRequestEvent {
  type: "plan_review_request";
  callId: string;
  planId: string;
  planPath: string;
  planMarkdown: string;
  options?: readonly PlanReviewOptionView[];
  revision: number;
}

export interface RunPlanReviewResolvedEvent {
  type: "plan_review_resolved";
  callId: string;
  decision: PlanReviewDecision;
}

export type RunPlanReviewEvent =
  | RunPlanReviewRequestEvent
  | RunPlanReviewResolvedEvent;

/**
 * 子代理域事件(Eva 自有域,与主 SDK 命名空间隔离)。
 * 信封(parentToolCallId/subagentType)在唯一入口 runSubagent 注入,前端据此把
 * 子代理的内部流归到某个 Task 调用(卡片),而不是当主链 token 看待。
 */
export interface RunSubagentUpdateEvent {
  type: "subagent_update";
  taskId: string;
  parentToolCallId: string;
  subagentType: string;
  /** 3-5 词任务名 —— 卡片标题用它区分并行派出的多个子代理。 */
  description: string;
  event: RunAgentStreamEvent;
}

/**
 * 子代理主动交付了结论(S7 push)。卡片据此即时显示"已回报",
 * 不必等主 loop 把它注入对话。
 */
export interface RunSubagentReportEvent {
  type: "subagent_report";
  taskId: string;
  parentToolCallId: string;
  description: string;
  output: string;
}

export type RunStreamEvent =
  | RunAgentStreamEvent
  | RunStartEvent
  | RunEndEvent
  | RunApprovalRequestEvent
  | RunApprovalResolvedEvent
  | RunPlanReviewRequestEvent
  | RunPlanReviewResolvedEvent
  | RunSubagentUpdateEvent
  | RunSubagentReportEvent;

/** 线上帧 = 事件 + seq；seq 单 run 内从 1 单调递增，含终态帧（accumulator 依赖此约定）。 */
export type RunStreamFrame = RunStreamEvent & { seq: number };
