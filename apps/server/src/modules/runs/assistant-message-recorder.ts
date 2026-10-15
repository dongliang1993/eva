import { randomUUID } from "node:crypto";

import type {
  ApprovalDecision,
  EvaDynamicToolPart,
  EvaUIMessage,
  PlanReviewDecision,
  RunAgentStreamEvent,
  RunStreamEvent,
  StreamFinishReason,
  StreamTokenUsage
} from "@eva/shared";
import { UiMessageBuilder, isDynamicToolPart, toErrorMessage } from "@eva/shared";

import type { RunFailureLayer } from "../../db/schema.js";
import type { MessagePosition, SessionService } from "../sessions/index.js";

export interface AssistantMessageRecorderOptions {
  readonly sessionId: string;
  readonly runId: string;
  readonly model: string;
  readonly initialPosition: MessagePosition;
  /**
   * T30:finish 落库前查每个 tool part 的审批决策,有则回写进 part.toolMetadata。
   * 决策数据源是 approval_requests 行(finish 时已 decided),不是 SSE 事件。
   */
  readonly lookupDecision?: (callId: string) => ApprovalDecision | undefined;
  /** T45b:exit_plan_mode 的 plan review 决策定格,写进 part.toolMetadata.planReviewDecision。 */
  readonly lookupPlanReviewDecision?: (callId: string) => PlanReviewDecision | undefined;
}

export interface RecordedAssistantRun {
  readonly failureLayer?: RunFailureLayer;
  readonly assistantMessageId: string;
  readonly finishReason: StreamFinishReason;
  readonly usage?: StreamTokenUsage | undefined;
  readonly streamError?: string | undefined;
}

/**
 * 流式期间多久至少落一次库。工具与步边界另外立即落 —— 崩溃时最多丢这么长的正文,
 * 而不会丢一次工具调用或它的结果。
 */
const CHECKPOINT_INTERVAL_MS = 1000;

const isCheckpointBoundary = (event: RunAgentStreamEvent): boolean =>
  event.type === "tool-call" || event.type === "tool-result" || event.type === "step-start";

/** 
 * 对话内容记录器
 * 用户在 UI 里看到的消息文本、工具调用、工具结果，最终存进 messages 表(会话对话记录)。
 * */
export class AssistantMessageRecorder {
  private builder = new UiMessageBuilder(randomUUID());
  private position: MessagePosition;
  private finishReason: StreamFinishReason = "error";
  private failureLayer: RunFailureLayer | undefined;
  private usage: StreamTokenUsage | undefined;
  private streamError: string | undefined = "Agent stream ended without a terminal outcome";
  private lastCheckpointAt = Date.now();

  constructor(
    private readonly session: SessionService,
    private readonly options: AssistantMessageRecorderOptions
  ) {
    this.position = options.initialPosition;
  }

  /** 收一帧,并按边界/节流决定是否落一次检查点。参数是 RunStreamEvent:server 域帧(approval_*)静默忽略。 */
  record(event: RunStreamEvent): void {
    if (!isAgentStreamEvent(event)) return;
    this.recordAgent(event);
  }

  private recordAgent(event: RunAgentStreamEvent): void {
    this.push(event);
    if (isCheckpointBoundary(event) || Date.now() - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
      this.checkpoint();
    }
  }

  push(event: RunAgentStreamEvent): void {
    this.builder.push(event);

    if (event.type === "finish") {
      this.finishReason = event.finishReason;
      this.usage = event.usage;
      // error 收口的 streamError 保留(前面的 error 帧写的);finish 只把别的终态清掉。
      if (event.finishReason !== "error") {
        this.streamError = undefined;
      }
      this.failureLayer = event.finishReason === "max-steps" ? "orchestration" : undefined;
      return;
    }

    if (event.type === "error") {
      this.finishReason = "error";
      this.streamError = event.message;
      this.failureLayer = event.failureLayer ?? "unknown";
    }
  }

  fail(error: unknown, aborted: boolean): void {
    this.finishReason = aborted ? "aborted" : "error";
    this.streamError = toErrorMessage(error);
    this.failureLayer = aborted ? undefined : "unknown";
  }

  snapshot(): EvaUIMessage {
    return this.builder.snapshot({
      runId: this.options.runId,
      model: this.options.model
    });
  }

  checkpoint(): void {
    this.lastCheckpointAt = Date.now();
    this.session.recordAssistantMessage(
      this.options.sessionId,
      this.withApprovalDecisions(this.snapshot()),
      this.position,
      this.options.runId
    );
  }

  finish(): RecordedAssistantRun {
    const assistantMessage = this.builder.build({
      runId: this.options.runId,
      model: this.options.model,
      ...(this.finishReason === "aborted" ? { aborted: true } : {})
    });
    const stored = this.session.recordAssistantMessage(
      this.options.sessionId,
      this.withApprovalDecisions(assistantMessage),
      this.position,
      this.options.runId
    );

    return {
      ...(this.failureLayer ? { failureLayer: this.failureLayer } : {}),
      assistantMessageId: stored.id,
      finishReason: this.finishReason,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
      ...(this.streamError !== undefined ? { streamError: this.streamError } : {})
    };
  }

  /**
   * T30:finish 落库前把已决策审批回写进 tool part 的 toolMetadata。
   * 只动 toolMetadata,不动 part.state(坑 5:denied 的 output 本来就是
   * output-available,改 state 会污染 convertToModelMessages 回灌语义)。
   * 查不到决策行 / 仍 pending 的 part 原样保留。
   */
  private withApprovalDecisions(message: EvaUIMessage): EvaUIMessage {
    const lookup = this.options.lookupDecision;
    if (!lookup) return message;

    let touched = false;
    const lookupPlanReview = this.options.lookupPlanReviewDecision;
    const parts = message.parts.map((part) => {
      if (!isDynamicToolPart(part)) return part;
      const decision = lookup(part.toolCallId);
      const planReviewDecision = lookupPlanReview?.(part.toolCallId);
      if (!decision && !planReviewDecision) return part;
      touched = true;
      // toolMetadata 是宽松 JSONValue 记录,spread 后 SDK 判别联合收窄不了 —— 经 unknown 转回。
      return {
        ...part,
        toolMetadata: {
          ...part.toolMetadata,
          ...(decision !== undefined ? { approvalDecision: decision } : {}),
          ...(planReviewDecision !== undefined ? { planReviewDecision } : {})
        }
      } as unknown as EvaDynamicToolPart;
    });

    return touched ? { ...message, parts } : message;
  }

}


/** agent 域帧判别(SSE 协议的 harness 侧子集)。 */
const isAgentStreamEvent = (event: RunStreamEvent): event is RunAgentStreamEvent =>
  event.type === "text-delta" ||
  event.type === "reasoning-delta" ||
  event.type === "tool-input-start" ||
  event.type === "tool-input-delta" ||
  event.type === "tool-call" ||
  event.type === "tool-result" ||
  event.type === "step-start" ||
  event.type === "finish" ||
  event.type === "error";
