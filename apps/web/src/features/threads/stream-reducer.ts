import type { EvaUIMessage, RunAgentStreamEvent, UiMessageBuilder } from "@eva/shared";

import type { ThreadMessage } from "../../types/api";

/**
 * 一个会话的投影状态 —— 「屏幕上现在该显示什么」的唯一事实源。
 *
 * 纯函数、无 React 依赖:所有分支都可以用一串固定事件喂出来验证(§11.5)。
 *
 * 【不许合并 committed 与 streaming】这是已经验证过的性能结构:一次 text-delta
 * 只换 streaming 一个引用,committed 数组的引用完全不动,memo 住的历史消息列表
 * 因此整轮流式都不重渲染。把在飞消息并进 committed 会让每帧都重建整个数组。
 */
export interface ChatProjection {
  /** 已完成的消息(引用只在轮次边界变化)。 */
  readonly committed: readonly EvaUIMessage[];
  /** 在飞的 assistant 消息;null 表示当前没有 run。 */
  readonly streaming: EvaUIMessage | null;
  readonly isStreaming: boolean;
  readonly sessionId: string | null;
  /** 在跟的 run —— 有值停止按钮才可用(刷新后重挂也因此恢复可用)。 */
  readonly runId: string | null;
  /** id → 同槽位全部版本 id。服务端算准,前端只整体替换。 */
  readonly siblingIdsById: SiblingIdsById;
}

export type SiblingIdsById = Readonly<Record<string, readonly string[]>>;

export type ChatProjectionAction =
  /** 切到某个会话:清空本地投影,等 thread/loaded 填。 */
  | { readonly type: "thread/opened"; readonly threadId: string }
  /** 新会话:同上,且没有 sessionId。 */
  | { readonly type: "thread/reset" }
  /** 从服务端对齐一轮激活链(load / switchVersion / run 结束后回灌都走它)。 */
  | { readonly type: "thread/loaded"; readonly rows: readonly ThreadMessage[] }
  /** 乐观插入用户消息。 */
  | { readonly type: "message/appended"; readonly message: EvaUIMessage }
  /** 撤掉一条本地消息(409 回滚、regenerate 先摘掉被重试那条)。 */
  | { readonly type: "message/dropped"; readonly messageId: string }
  /** 新 run:先亮一个空气泡,runId 要等 run_start 帧才知道。 */
  | { readonly type: "run/opening"; readonly assistantId: string }
  /** 重挂在飞的 run:runId 一开始就知道,所以停止按钮立刻可用。 */
  | { readonly type: "run/attaching"; readonly runId: string; readonly assistantId: string }
  | { readonly type: "run/started"; readonly runId: string; readonly threadId: string }
  /** 累积器投影出的最新快照。 */
  | { readonly type: "run/streamed"; readonly message: EvaUIMessage }
  | { readonly type: "run/errored"; readonly assistantId: string; readonly message: string }
  /** 终态:把最终 assistant 消息并进 committed(没有累积器时 message 为 null)。 */
  | { readonly type: "run/settled"; readonly message: EvaUIMessage | null }
  /** 服务端 409 挡了这一轮:这条连接从没开始流,投影退回没有 run 的样子。 */
  | { readonly type: "run/rejected" };

export const initialChatProjection: ChatProjection = {
  committed: [],
  streaming: null,
  isStreaming: false,
  sessionId: null,
  runId: null,
  siblingIdsById: {}
};

/** 一个空的在飞气泡 —— 新 run 与重挂共用同一个起点。 */
const openingBubble = (assistantId: string): EvaUIMessage => ({
  id: assistantId,
  role: "assistant",
  parts: []
});

/** 从服务端行投影激活链:messages 与 siblingIds 一体更新(服务端才算得准 sibling)。 */
const fromThreadMessages = (
  rows: readonly ThreadMessage[]
): Pick<ChatProjection, "committed" | "siblingIdsById"> => {
  const byId: Record<string, readonly string[]> = {};
  for (const row of rows) {
    byId[row.id] = row.siblingIds;
  }

  return {
    committed: rows.map((row) => row.message),
    siblingIdsById: byId
  };
};

export const chatProjectionReducer = (
  state: ChatProjection,
  action: ChatProjectionAction
): ChatProjection => {
  switch (action.type) {
    case "thread/opened":
      return {
        ...initialChatProjection,
        sessionId: action.threadId
      };

    case "thread/reset":
      return initialChatProjection;

    case "thread/loaded":
      return { ...state, ...fromThreadMessages(action.rows) };

    case "message/appended":
      return { ...state, committed: [...state.committed, action.message] };

    case "message/dropped":
      return {
        ...state,
        committed: state.committed.filter((m) => m.id !== action.messageId)
      };

    case "run/opening":
      return {
        ...state,
        streaming: openingBubble(action.assistantId),
        isStreaming: true,
        runId: null
      };

    case "run/attaching":
      return {
        ...state,
        streaming: openingBubble(action.assistantId),
        isStreaming: true,
        runId: action.runId
      };

    case "run/started":
      return { ...state, runId: action.runId, sessionId: action.threadId };

    case "run/streamed":
      return { ...state, streaming: action.message };

    // 半成品消息仍然可见:错误文本替换在飞气泡,run 还没结束(终态由 end 帧给)。
    case "run/errored":
      return {
        ...state,
        streaming: {
          id: action.assistantId,
          role: "assistant",
          parts: [{ type: "text", text: `Error: ${action.message}`, state: "done" }]
        }
      };

    case "run/settled":
      return {
        ...state,
        committed: action.message === null
          ? state.committed
          : [...state.committed, action.message],
        streaming: null,
        isStreaming: false,
        runId: null
      };

    case "run/rejected":
      return { ...state, streaming: null, isStreaming: false, runId: null };

    default:
      return state;
  }
};

/**
 * 把一个流事件喂给累积器,再投影出新 state —— run controller 的 onEvent 唯一实现,
 * 也是 §11.5 事件序列测试的入口。
 *
 * 累积器留在外面而不是进 state,有两个不能绕的理由:一是 `UiMessageBuilder` 是
 * server/web 共用的唯一实现(在 shared 里),前端不能有第二份;二是它是可变累积器,
 * 放进 `useReducer` 会被 StrictMode 的双跑推两次,同一段文本出现两遍。
 */
export const applyRunEvent = (
  state: ChatProjection,
  builder: UiMessageBuilder,
  event: RunAgentStreamEvent
): ChatProjection => {
  builder.push(event);

  return chatProjectionReducer(state, { type: "run/streamed", message: builder.snapshot() });
};
