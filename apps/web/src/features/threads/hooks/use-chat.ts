import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type {
  EvaUIMessage,
  RunAgentStreamEvent,
  RunApprovalRequestEvent,
  RunApprovalResolvedEvent,
  RunSubagentUpdateEvent,
  RunSubagentReportEvent
} from "@eva/shared";
import { UiMessageBuilder, createUserUIMessage } from "@eva/shared";

import {
  abortRun,
  attachRun as attachRunApi,
  streamChat,
  type StreamCallbacks,
  type StreamRequest
} from "../../../shared/api/run-stream-client";
import {
  fetchThreadMessages,
  fetchThreadStatus,
  switchVersion as switchVersionApi
} from "../api";
import type { ThreadMessage } from "../../../types/api";

export interface UseChatHandlers {
  /** 审批事件(T0.4 引入的 SSE 事件),由 useApprovals 驱动。 */
  readonly onApproval?: (event: RunApprovalRequestEvent | RunApprovalResolvedEvent) => void;
  /** S7:子代理事件 —— 与主链隔离,由 useSubagents 累积(绝不并进主 builder)。 */
  readonly onSubagent?: (event: RunSubagentUpdateEvent) => void;
  /** S7:子代理主动交付结论 —— 卡片即时显示"已回报"。 */
  readonly onSubagentReport?: (event: RunSubagentReportEvent) => void;
  /**
   * 这一句被 409 挡了(会话里还有一轮在飞):hook 已经挂到在跑的那个 run 上,
   * 但用户刚打的字不能就这么吞掉 —— 交给页面放回输入框并提示一句。
   * retry 被挡时没有"刚打的字",text 为 undefined。
   */
  readonly onRejected?: (text: string | undefined) => void;
}

export type SiblingIdsById = Readonly<Record<string, readonly string[]>>;

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

/** 从服务端拉激活链,messages 与 siblingIds 一体更新(服务端才算得准 sibling)。 */
const fromThreadMessages = (
  rows: readonly ThreadMessage[]
): { messages: readonly EvaUIMessage[]; siblingIdsById: SiblingIdsById } => {
  const byId: Record<string, readonly string[]> = {};
  for (const row of rows) {
    byId[row.id] = row.siblingIds;
  }

  return {
    messages: rows.map((row) => row.message),
    siblingIdsById: byId
  };
};

export function useChat(handlers: UseChatHandlers = {}): UseChatReturn {
  const queryClient = useQueryClient();
  const [committed, setCommitted] = useState<EvaUIMessage[]>([]);
  const [siblingIdsById, setSiblingIdsById] = useState<SiblingIdsById>({});
  const [streaming, setStreaming] = useState<EvaUIMessage | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const builderRef = useRef<UiMessageBuilder | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // 供事件回调读取最新值的 ref —— 回调里不用把它放进依赖,setX 始终最新。
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  /** 从服务端对齐一轮消息(messages + siblingIds 一体替换)。 */
  const syncFromServer = useCallback((threadId: string): void => {
    fetchThreadMessages(threadId)
      .then((rows) => {
        const { messages, siblingIdsById: byId } = fromThreadMessages(rows);
        setCommitted([...messages]);
        setSiblingIdsById(byId);
      })
      .catch(() => {
        // 拉取失败保留本地;用户切会话重试即可。
      });
  }, []);

  /** 结算一条流式 run:把最终 assistant 消息并进 committed,再从服务端对齐一轮。 */
  const settleRun = useCallback((threadId: string): void => {
    const builder = builderRef.current;
    if (builder) {
      setCommitted((prev) => [...prev, builder.build()]);
      builderRef.current = null;
    }
    setStreaming(null);
    setIsStreaming(false);
    runIdRef.current = null;
    syncFromServer(threadId);
  }, [syncFromServer]);

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

  /** 新 run 与重连共用的一套回调 —— 重连没有"专用分支"是 Step 2 合成帧的目的。 */
  const consumeRun = useCallback((assistantId: string): StreamCallbacks => ({
    onRunStart(runId, returnedSessionId) {
      runIdRef.current = runId;
      sessionIdRef.current = returnedSessionId;
      setSessionId(returnedSessionId);
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    },

    onEvent(event) {
      const builder = builderRef.current;
      if (!builder) {
        return;
      }
      builder.push(event);
      // 只换 streaming 这一个引用 —— committed 数组完全不动
      setStreaming(builder.snapshot());
    },

    onApproval(event) {
      handlersRef.current.onApproval?.(event);
    },

    onSubagent(event) {
      handlersRef.current.onSubagent?.(event);
    },

    onSubagentReport(event) {
      handlersRef.current.onSubagentReport?.(event);
    },

    onError(message) {
      setStreaming({
        id: assistantId,
        role: "assistant",
        parts: [{ type: "text", text: `Error: ${message}`, state: "done" }]
      });
    },

    onEnd() {
      const threadId = sessionIdRef.current;
      if (threadId) {
        settleRun(threadId);
      }
    }
  }), [queryClient, settleRun]);

  /**
   * 挂回一个在飞的 run。服务端先补齐已经流过的部分(合成帧),再继续推新帧。
   *
   * 本地 assistantId 随便取:结束时 settleRun → syncFromServer 会用 DB 行整体替换。
   * 副作用之一是 runIdRef 有值了 —— 刷新之后停止按钮因此重新可用。
   */
  const attachRun = useCallback((runId: string): void => {
    // 已经在跟这个 run 了(发现逻辑可能被触发两次),别开第二条连接。
    if (runIdRef.current === runId) return;

    const assistantId = crypto.randomUUID();
    builderRef.current = new UiMessageBuilder(assistantId);
    setStreaming({ id: assistantId, role: "assistant", parts: [] });
    setIsStreaming(true);
    runIdRef.current = runId;

    void attachRunApi(runId, consumeRun(assistantId), openStream());
  }, [consumeRun, openStream]);

  const startRun = useCallback((
    assistantId: string,
    body: { text?: string; retryMessageId?: string },
    /** send 必给;retry 不给(服务端沿用被重试那轮的模型)。 */
    modelId?: string,
    /** 409 被挡时的补救:调用方先把乐观更新回滚,再由这里挂到在跑的 run 上。 */
    onRejected?: () => void
  ): void => {
    builderRef.current = new UiMessageBuilder(assistantId);
    setStreaming({ id: assistantId, role: "assistant", parts: [] });
    setIsStreaming(true);
    runIdRef.current = null;

    const request: StreamRequest = {
      sessionId: sessionIdRef.current ?? undefined,
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
        setStreaming(null);
        setIsStreaming(false);
        runIdRef.current = null;
        onRejected?.();
        handlersRef.current.onRejected?.(body.text);
        attachRun(activeRunId);
      }
    }, openStream());
  }, [attachRun, consumeRun, openStream]);

  const sendMessage = useCallback((text: string, modelId: string) => {
    const trimmed = text.trim();
    if (isStreamingRef.current || trimmed.length === 0) {
      return;
    }

    const userMessage = createUserUIMessage(crypto.randomUUID(), trimmed);
    // 用户消息一次性进 committed;assistant 走 streaming 通道。
    setCommitted((prev) => [...prev, userMessage]);
    startRun(crypto.randomUUID(), { text: trimmed }, modelId, () => {
      // 409:服务端没收这条,本地也不能留着假消息。
      setCommitted((prev) => prev.filter((m) => m.id !== userMessage.id));
    });
  }, [startRun]);

  const regenerate = useCallback((messageId: string) => {
    if (isStreamingRef.current || !sessionIdRef.current) {
      return;
    }
    // 先移除被重试的那条(同槽位会重新落库一个 v2),再开一个流式气泡。
    const threadId = sessionIdRef.current;
    setCommitted((prev) => prev.filter((m) => m.id !== messageId));
    startRun(crypto.randomUUID(), { retryMessageId: messageId }, undefined, () => {
      // 409:这条 assistant 消息还在服务端,把刚才移除的它拉回来。
      syncFromServer(threadId);
    });
  }, [startRun, syncFromServer]);

  const switchVersion = useCallback((messageId: string) => {
    switchVersionApi(messageId)
      .then((rows) => {
        const { messages, siblingIdsById: byId } = fromThreadMessages(rows);
        setCommitted([...messages]);
        setSiblingIdsById(byId);
      })
      .catch(() => {
        // 切换失败保留当前分支。
      });
  }, []);

  const stopStreaming = useCallback(() => {
    if (!isStreamingRef.current || !runIdRef.current) return;
    abortRun(runIdRef.current).catch(() => {});
  }, []);

  const newConversation = useCallback(() => {
    streamAbortRef.current?.abort();
    builderRef.current = null;
    setIsStreaming(false);
    runIdRef.current = null;
    setCommitted([]);
    setSiblingIdsById({});
    setStreaming(null);
    sessionIdRef.current = null;
    setSessionId(null);
  }, []);

  const loadSession = useCallback((threadId: string) => {
    // 已经在跟这个会话的流 → 什么都别做(重载会把在飞气泡打断)。
    // 但「同 id 且没在跟流」要放过去:刷新后点回同一个会话仍要能发现在飞的 run。
    if (threadId === sessionIdRef.current && isStreamingRef.current) return;

    streamAbortRef.current?.abort();
    builderRef.current = null;
    setIsStreaming(false);
    runIdRef.current = null;

    sessionIdRef.current = threadId;
    setSessionId(threadId);
    setCommitted([]);
    setSiblingIdsById({});
    setStreaming(null);

    fetchThreadMessages(threadId)
      .then((rows) => {
        const { messages, siblingIdsById: byId } = fromThreadMessages(rows);
        setCommitted([...messages]);
        setSiblingIdsById(byId);
      })
      .catch(() => {
        // Session not found or error — stay with empty messages
      });

    // 发现:这个会话可能有一轮还在服务端跑(上次刷新只是断了连接,没停 run)。
    // 拿到 activeRunId 就挂回去;拿不到就是纯只读历史。
    fetchThreadStatus(threadId)
      .then((status) => {
        // 期间用户又切走了 → 别把别的会话的流挂上来。
        if (status.activeRunId === null || sessionIdRef.current !== threadId) return;
        attachRun(status.activeRunId);
      })
      .catch(() => {
        // 状态拉不到就退回只读历史,不打断用户。
      });
  }, [attachRun]);

  return {
    messages: committed,
    streamingMessage: streaming,
    isStreaming,
    sessionId,
    siblingIdsById,
    sendMessage,
    regenerate,
    switchVersion,
    stopStreaming,
    attachRun,
    newConversation,
    loadSession
  };
}