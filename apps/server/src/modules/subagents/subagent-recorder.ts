import { randomUUID } from "node:crypto";

import type { RunAgentStreamEvent, EvaUIMessage } from "@eva/shared";
import { UiMessageBuilder } from "@eva/shared";

import type { IMessageRepository } from "../../db/repositories/types.js";

export interface SubagentRecorderConfig {
  readonly sessionId: string;
  /** 子代理消息的挂点 —— 与 messages.parent_tool_call_id 同一值。 */
  readonly parentToolCallId: string;
  readonly runId?: string;
  readonly model?: string;
}

/**
 * 每个子代理任务一个 recorder:把该任务的流事件累积成一条 assistant UIMessage,
 * 结束时把「任务简报」的 user 消息 + 子代理 assistant 消息一起写进 messages 表,
 * 都打 parent_tool_call_id —— 从而被 buildActiveChain 的主链过滤挡在外面。
 *
 * 关键:不走 sessionService.recordAssistantMessage(那会更新 activeLeaf,把子代理
 * 消息挂到主链上)。这里直接经由 IMessageRepository 写,维持版本树线索(assistant
 * 的 parentId = job brief),但 parent_tool_call_id 非空 → 隔离成立。
 */
export class SubagentRecorder {
  private readonly brief: EvaUIMessage;
  private readonly assistantBuilder: UiMessageBuilder;
  private finished = false;

  constructor(
    private readonly repo: IMessageRepository,
    private readonly config: SubagentRecorderConfig,
    jobPrompt: string,
    private readonly briefId = randomUUID(),
    private readonly assistantId = randomUUID()
  ) {
    this.brief = {
      id: this.briefId,
      role: "user",
      parts: [{ type: "text", text: jobPrompt, state: "done" }],
      metadata: { ...(config.runId ? { runId: config.runId } : {}) }
    };
    this.assistantBuilder = new UiMessageBuilder(this.assistantId);
  }

  /** 收进一个子代理裸事件(信封已在调用方解开)。 */
  push(raw: RunAgentStreamEvent): void {
    if (this.finished) return;
    this.assistantBuilder.push(raw);
  }

  /** 幂等封口:写 brief + assistant 两条消息,都带 parent_tool_call_id。重复调用只写一次。 */
  flush(): { readonly briefId: string; readonly assistantId: string } {
    if (this.finished) {
      return { briefId: this.briefId, assistantId: this.assistantId };
    }
    this.finished = true;

    const assistant = this.assistantBuilder.build({
      ...(this.config.runId ? { runId: this.config.runId } : {}),
      ...(this.config.model ? { model: this.config.model } : {})
    });

    // 主链之外:直接 repo 落库,不更新 activeLeaf,不碰版本树三件套的 root。
    this.repo.create({
      sessionId: this.config.sessionId,
      message: this.brief,
      parentToolCallId: this.config.parentToolCallId
    });
    this.repo.create({
      sessionId: this.config.sessionId,
      message: assistant,
      parentId: this.briefId, // 子代理的 assistant 接在它的 job brief 之后
      parentToolCallId: this.config.parentToolCallId
    });

    return { briefId: this.briefId, assistantId: this.assistantId };
  }
}
