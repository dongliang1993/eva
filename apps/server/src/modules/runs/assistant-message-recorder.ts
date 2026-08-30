import { randomUUID } from "node:crypto";

import type {
  ApprovalDecision,
  EvaDynamicToolPart,
  EvaUIMessage,
  PlanReviewDecision,
  RunAgentStreamEvent,
  StreamFinishReason,
  StreamTokenUsage
} from "@eva/shared";
import { UiMessageBuilder, createUserUIMessage, isDynamicToolPart } from "@eva/shared";

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
  readonly assistantMessageId: string;
  readonly finishReason: StreamFinishReason;
  readonly usage?: StreamTokenUsage | undefined;
  readonly streamError?: string | undefined;
}

/**
 * 把一轮 agent 事件折叠成持久化消息。
 *
 * notice-injected 是消息边界：先收口当前 assistant，再把通知作为主链消息落库，
 * 最后用新的 builder 继续下一段 assistant。
 */
export class AssistantMessageRecorder {
  private builder = new UiMessageBuilder(randomUUID());
  private position: MessagePosition;
  private finishReason: StreamFinishReason = "stop";
  private usage: StreamTokenUsage | undefined;
  private streamError: string | undefined;

  constructor(
    private readonly session: SessionService,
    private readonly options: AssistantMessageRecorderOptions
  ) {
    this.position = options.initialPosition;
  }

  push(event: RunAgentStreamEvent): void {
    this.builder.push(event);

    if (event.type === "notice-injected") {
      this.recordNoticeBoundary(event);
      return;
    }

    if (event.type === "finish") {
      this.finishReason = event.finishReason;
      this.usage = event.usage;
      return;
    }

    if (event.type === "error") {
      this.finishReason = "error";
      this.streamError = event.message;
    }
  }

  /**
   * 当前在飞 assistant 消息的快照 —— SSE 重连时反推成合成帧补历史(RunHub.attach)。
   * 读的是**当前那个** builder:notice-injected 边界前的消息已经落库了。
   */
  snapshot(): EvaUIMessage {
    return this.builder.snapshot({
      runId: this.options.runId,
      model: this.options.model
    });
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

  private recordNoticeBoundary(
    event: Extract<RunAgentStreamEvent, { type: "notice-injected" }>
  ): void {
    this.session.recordAssistantMessage(
      this.options.sessionId,
      this.builder.build({
        runId: this.options.runId,
        model: this.options.model
      }),
      this.position,
      this.options.runId
    );

    for (const notice of event.notices) {
      this.session.continueSession(
        this.options.sessionId,
        createUserUIMessage(randomUUID(), notice.text, {
          runId: this.options.runId,
          noticeKind: notice.kind === "reported"
            ? "subagent_reported"
            : "subagent_settled",
          noticeDescription: notice.description
        }),
        this.options.runId
      );
    }

    this.position = this.session.positionAfterActiveLeaf(this.options.sessionId);
    this.builder = new UiMessageBuilder(randomUUID());
  }
}
