import { useCallback, useRef, useState } from "react";

import type { EvaUIMessage } from "@eva/shared";

import {
  chatProjectionReducer,
  initialChatProjection,
  type ChatProjection,
  type ChatProjectionAction,
  type SiblingIdsById
} from "../stream-reducer";
import type { UseChatHandlers } from "./use-chat-handlers";
import { useRunController } from "./use-run-controller";
import { useThreadMessages } from "./use-thread-messages";

// 页面与 version-actions-context 一直从这里 import 这两个类型,出口保持不动。
export type { SiblingIdsById } from "../stream-reducer";
export type { UseChatHandlers } from "./use-chat-handlers";

interface UseChatReturn {
  /** 已完成的消息(引用只在轮次边界变化)。 */
  readonly messages: readonly EvaUIMessage[];
  /** 在飞的 assistant 消息;null 表示当前没有 run。 */
  readonly streamingMessage: EvaUIMessage | null;
  readonly isStreaming: boolean;
  readonly sessionId: string | null;
  /** id → 同槽位全部版本 id。服务端算准,前端只在 run 结束/load/switch 时整体替换。 */
  readonly siblingIdsById: SiblingIdsById;
  /** modelId 必填 —— 模型是 per-run 选定的,没选模型时发送按钮就是禁用的。 */
  readonly sendMessage: (text: string, modelId: string) => void;
  /** 重新生成激活链最后一条 assistant 消息(同槽位落新版本)。 */
  readonly regenerate: (messageId: string) => void;
  /** 切到某条消息所在分支的叶子(前端只在同槽位版本间调)。 */
  readonly switchVersion: (messageId: string) => void;
  readonly stopStreaming: () => void;
  /** 挂回一个已经在飞的 run(刷新后续跟流)。loadSession 会自动发现并调用它。 */
  readonly attachRun: (runId: string) => void;
  readonly newConversation: () => void;
  readonly loadSession: (threadId: string) => void;
}

/**
 * 一个会话的读写入口 —— 只做三件事:持有投影、把它拆给两个子 hook、组合会话切换。
 *
 * 投影本身是 stream-reducer 里的纯函数(有 §11.5 的事件序列测试兜着);
 * 历史侧在 use-thread-messages,在飞侧在 use-run-controller。
 * 投影只有这一个持有者:两个子 hook 都只拿到 dispatch,不能各留一份状态(§6)。
 */
export function useChat(handlers: UseChatHandlers = {}): UseChatReturn {
  const [projection, setProjection] = useState<ChatProjection>(initialChatProjection);
  // 供事件回调读取最新值的 ref —— 回调里不用把它放进依赖,dispatch 始终基于最新投影。
  const projectionRef = useRef(projection);

  const dispatch = useCallback((action: ChatProjectionAction): void => {
    const next = chatProjectionReducer(projectionRef.current, action);
    if (next === projectionRef.current) {
      return;
    }
    projectionRef.current = next;
    setProjection(next);
  }, []);

  const getProjection = useCallback((): ChatProjection => projectionRef.current, []);

  const { syncFromServer, switchVersion, fetchActiveRunId } = useThreadMessages(dispatch);
  const { sendMessage, regenerate, stopStreaming, attachRun, detachStream } = useRunController({
    dispatch,
    getProjection,
    handlers,
    syncFromServer
  });

  const newConversation = useCallback(() => {
    detachStream();
    dispatch({ type: "thread/reset" });
  }, [detachStream, dispatch]);

  const loadSession = useCallback((threadId: string) => {
    // 已经在跟这个会话的流 → 什么都别做(重载会把在飞气泡打断)。
    // 但「同 id 且没在跟流」要放过去:刷新后点回同一个会话仍要能发现在飞的 run。
    const current = getProjection();
    if (threadId === current.sessionId && current.isStreaming) return;

    detachStream();
    dispatch({ type: "thread/opened", threadId });
    syncFromServer(threadId);

    // 发现:这个会话可能有一轮还在服务端跑(上次刷新只是断了连接,没停 run)。
    // 拿到 activeRunId 就挂回去;拿不到就是纯只读历史。
    void fetchActiveRunId(threadId).then((activeRunId) => {
      // 期间用户又切走了 → 别把别的会话的流挂上来。
      if (activeRunId === null || getProjection().sessionId !== threadId) return;
      attachRun(activeRunId);
    });
  }, [attachRun, detachStream, dispatch, fetchActiveRunId, getProjection, syncFromServer]);

  return {
    messages: projection.committed,
    streamingMessage: projection.streaming,
    isStreaming: projection.isStreaming,
    sessionId: projection.sessionId,
    siblingIdsById: projection.siblingIdsById,
    sendMessage,
    regenerate,
    switchVersion,
    stopStreaming,
    attachRun,
    newConversation,
    loadSession
  };
}
