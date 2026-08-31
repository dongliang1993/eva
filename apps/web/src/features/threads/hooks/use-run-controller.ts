import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { UiMessageBuilder, createUserUIMessage } from "@eva/shared";

import {
  abortRun,
  attachRun as attachRunApi,
  streamChat,
  type StreamCallbacks,
  type StreamRequest
} from "../../../shared/api/run-stream-client";
import {
  runStreamedAction,
  type ChatProjection,
  type ChatProjectionAction
} from "../stream-reducer";
import type { UseChatHandlers } from "./use-chat-handlers";

/**
 * 在飞侧 —— 一条 SSE 连接的生命周期(§7.18)。
 *
 * 独占两个可变引用:累积器与当前连接的 AbortController。投影状态不在这里,
 * 它统一由 use-chat 持有,这一层只派 action(§6 单一归属)。
 */
export interface UseRunControllerResult {
  /** modelId 必填 —— 模型是 per-run 选定的,没选模型时发送按钮就是禁用的。 */
  readonly sendMessage: (text: string, modelId: string) => void;
  /** 重新生成激活链最后一条 assistant 消息(同槽位落新版本)。 */
  readonly regenerate: (messageId: string) => void;
  readonly stopStreaming: () => void;
  /** 挂回一个已经在飞的 run(刷新后续跟流)。 */
  readonly attachRun: (runId: string) => void;
  /** 掐断当前读循环并丢掉累积器 —— 切会话 / 新会话前调。 */
  readonly detachStream: () => void;
}

interface UseRunControllerOptions {
  readonly dispatch: (action: ChatProjectionAction) => void;
  /** 读最新投影 —— 回调里不用把它放进依赖。 */
  readonly getProjection: () => ChatProjection;
  readonly handlers: UseChatHandlers;
  /** run 结束 / 409 回滚时从服务端对齐一轮。 */
  readonly syncFromServer: (threadId: string) => void;
}

export function useRunController({
  dispatch,
  getProjection,
  handlers,
  syncFromServer
}: UseRunControllerOptions): UseRunControllerResult {
  const queryClient = useQueryClient();
  const builderRef = useRef<UiMessageBuilder | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  /** 当前在跟的那条 SSE 连接 —— 切会话/新会话/卸载时用它掐断读循环。 */
  const streamAbortRef = useRef<AbortController | null>(null);

  const openStream = useCallback((): AbortSignal => {
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    return controller.signal;
  }, []);

  // 卸载时掐断:否则读循环还活着,onEnd 会去 settle 一个已经不存在的页面。
  useEffect(() => () => streamAbortRef.current?.abort(), []);

  const detachStream = useCallback((): void => {
    streamAbortRef.current?.abort();
    builderRef.current = null;
  }, []);

  /** 结算一条流式 run:把最终 assistant 消息并进 committed,再从服务端对齐一轮。 */
  const settleRun = useCallback((threadId: string): void => {
    const builder = builderRef.current;
    builderRef.current = null;
    dispatch({ type: "run/settled", message: builder ? builder.build() : null });
    syncFromServer(threadId);
  }, [dispatch, syncFromServer]);

  /** 新 run 与重连共用的一套回调 —— 重连没有"专用分支"是 Step 2 合成帧的目的。 */
  const consumeRun = useCallback((assistantId: string): StreamCallbacks => ({
    onRunStart(runId, returnedSessionId) {
      dispatch({ type: "run/started", runId, threadId: returnedSessionId });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    },

    onEvent(event) {
      const builder = builderRef.current;
      if (!builder) {
        return;
      }
      // 只换 streaming 这一个引用 —— committed 数组完全不动
      dispatch(runStreamedAction(builder, event));
    },

    onApproval(event) {
      handlersRef.current.onApproval?.(event);
    },

    onSubagent(event) {
      handlersRef.current.onSubagent?.(event);
    },

    onError(message) {
      dispatch({ type: "run/errored", assistantId, message });
    },

    onEnd() {
      const threadId = getProjection().sessionId;
      if (threadId) {
        settleRun(threadId);
      }
    }
  }), [dispatch, getProjection, queryClient, settleRun]);

  /**
   * 挂回一个在飞的 run。服务端先补齐已经流过的部分(合成帧),再继续推新帧。
   *
   * 本地 assistantId 随便取:结束时 settleRun → syncFromServer 会用 DB 行整体替换。
   * 副作用之一是投影里的 runId 有值了 —— 刷新之后停止按钮因此重新可用。
   */
  const attachRun = useCallback((runId: string): void => {
    // 已经在跟这个 run 了(发现逻辑可能被触发两次),别开第二条连接。
    if (getProjection().runId === runId) return;

    const assistantId = crypto.randomUUID();
    builderRef.current = new UiMessageBuilder(assistantId);
    dispatch({ type: "run/attaching", runId, assistantId });

    void attachRunApi(runId, consumeRun(assistantId), openStream());
  }, [consumeRun, dispatch, getProjection, openStream]);

  const startRun = useCallback((
    assistantId: string,
    body: { text?: string; retryMessageId?: string },
    /** send 必给;retry 不给(服务端沿用被重试那轮的模型)。 */
    modelId?: string,
    /** 409 被挡时的补救:调用方先把乐观更新回滚,再由这里挂到在跑的 run 上。 */
    onRejected?: () => void
  ): void => {
    builderRef.current = new UiMessageBuilder(assistantId);
    dispatch({ type: "run/opening", assistantId });

    const request: StreamRequest = {
      sessionId: getProjection().sessionId ?? undefined,
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.retryMessageId !== undefined ? { retryMessageId: body.retryMessageId } : {}),
      ...(modelId ? { modelId } : {})
    };

    void streamChat(request, {
      ...consumeRun(assistantId),

      // 服务端拒了这一轮(会话里还有一轮在飞):这条连接从没开始流,
      // 回滚乐观更新 + 转去 attach 在跑的那个 run,并把话说给用户听。
      onBusy(activeRunId) {
        builderRef.current = null;
        dispatch({ type: "run/rejected" });
        onRejected?.();
        handlersRef.current.onRejected?.(body.text);
        attachRun(activeRunId);
      }
    }, openStream());
  }, [attachRun, consumeRun, dispatch, getProjection, openStream]);

  const sendMessage = useCallback((text: string, modelId: string) => {
    const trimmed = text.trim();
    if (getProjection().isStreaming || trimmed.length === 0) {
      return;
    }

    const userMessage = createUserUIMessage(crypto.randomUUID(), trimmed);
    // 用户消息一次性进 committed;assistant 走 streaming 通道。
    dispatch({ type: "message/appended", message: userMessage });
    startRun(crypto.randomUUID(), { text: trimmed }, modelId, () => {
      // 409:服务端没收这条,本地也不能留着假消息。
      dispatch({ type: "message/dropped", messageId: userMessage.id });
    });
  }, [dispatch, getProjection, startRun]);

  const regenerate = useCallback((messageId: string) => {
    const { isStreaming, sessionId } = getProjection();
    if (isStreaming || !sessionId) {
      return;
    }
    // 先移除被重试的那条(同槽位会重新落库一个 v2),再开一个流式气泡。
    dispatch({ type: "message/dropped", messageId });
    startRun(crypto.randomUUID(), { retryMessageId: messageId }, undefined, () => {
      // 409:这条 assistant 消息还在服务端,把刚才移除的它拉回来。
      syncFromServer(sessionId);
    });
  }, [dispatch, getProjection, startRun, syncFromServer]);

  const stopStreaming = useCallback(() => {
    const { isStreaming, runId } = getProjection();
    if (!isStreaming || !runId) return;
    abortRun(runId).catch(() => {});
  }, [getProjection]);

  return { sendMessage, regenerate, stopStreaming, attachRun, detachStream };
}
