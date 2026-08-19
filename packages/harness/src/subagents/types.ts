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

/** runSubagent 跑完后的最终结果,由 subagent 工具 settle 进 task store。 */
export interface SubagentOutcome {
  readonly text: string;
}

/**
 * 一条要注入父 agent 的子代理通知(S7 push 模型)。
 *
 * 两类语义刻意分开:`reported` 是**内容**(子代理主动交付的结论,一次任务可有多条);
 * `settled` 是**生命周期**(它不会再干活了)。父 agent 对两者的反应不同 —— 前者要消费,
 * 后者只是知情。
 */
export interface SubagentNotice {
  readonly kind: "reported" | "settled";
  readonly taskId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  /** subagent 工具调用时给的 3-5 词任务名 —— 通知文本与卡片标题都用它。 */
  readonly description: string;
  /** kind=reported 时是 report 的内容;kind=settled 时是收尾语(可空)。 */
  readonly output?: string;
}

/** 通知 → 注入给模型的文本。措辞明确"结果会自动送到",断掉轮询的念头。 */
export const formatSubagentNotice = (notice: SubagentNotice): string => {
  const who = `Background subagent ${notice.taskId} (${notice.description})`;

  if (notice.kind === "reported") {
    return `${who} reported:\n\n${notice.output ?? ""}`;
  }

  const tail = notice.output !== undefined && notice.output.length > 0
    ? `\n\nIts closing message:\n\n${notice.output}`
    : "";

  return `${who} finished and will do no further work unless you send it more.${tail}`;
};
