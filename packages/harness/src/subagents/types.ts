/** 子代理内部流事件的"信封" —— 调用方永远拿不到裸事件(唯一注入点在 runSubagent)。 */
export interface SubagentEvent {
  readonly taskId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  /** 3-5 词任务名(与 SubagentNotice 同源,卡片标题用它)。 */
  readonly description: string;
  /** 与主线程同一套 AI SDK 事件命名,不另造一套。 */
  readonly event: import("@eva/shared").RunAgentStreamEvent;
}

export type SubagentEventSink = (event: SubagentEvent) => void;
