import type {
  RunApprovalRequestEvent,
  RunApprovalResolvedEvent,
  RunPlanReviewRequestEvent,
  RunPlanReviewResolvedEvent,
  RunSubagentUpdateEvent
} from "@eva/shared";

/**
 * 页面挂给 useChat 的回调 —— 主链之外的那几条通道。
 *
 * 单独一个文件是为了 use-run-controller 能拿到这个类型而不必反过来 import
 * use-chat(那是个环)。
 */
export interface UseChatHandlers {
  /** 审批事件(T0.4 引入的 SSE 事件 + T45b plan review 帧),由 useApprovals 驱动。 */
  readonly onApproval?: (
    event:
      | RunApprovalRequestEvent
      | RunApprovalResolvedEvent
      | RunPlanReviewRequestEvent
      | RunPlanReviewResolvedEvent
  ) => void;
  /** S7:子代理事件 —— 与主链隔离,由 useSubagents 累积(绝不并进主 builder)。 */
  readonly onSubagent?: (event: RunSubagentUpdateEvent) => void;
  /**
   * 这一句被 409 挡了(会话里还有一轮在飞):hook 已经挂到在跑的那个 run 上,
   * 但用户刚打的字不能就这么吞掉 —— 交给页面放回输入框并提示一句。
   * retry 被挡时没有"刚打的字",text 为 undefined。
   */
  readonly onRejected?: (text: string | undefined) => void;
}
