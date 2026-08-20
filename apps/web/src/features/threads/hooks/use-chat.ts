import { useCallback, useRef, useState } from "react";
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

import { abortRun, streamChat, type StreamRequest } from "../../../shared/api/run-stream-client";
import { fetchThreadMessages, switchVersion as switchVersionApi } from "../api";
import type { ThreadMessage } from "../../../types/api";

export interface UseChatHandlers {
  /** 审批事件(T0.4 引入的 SSE 事件),由 useApprovals 驱动。 */
  readonly onApproval?: (event: RunApprovalRequestEvent | RunApprovalResolvedEvent) => void;
  /** S7:子代理事件 —— 与主链隔离,由 useSubagents 累积(绝不并进主 builder)。 */
  readonly onSubagent?: (event: RunSubagentUpdateEvent) => void;
  /** S7:子代理主动交付结论 —— 卡片即时显示"已回报"。 */
  readonly onSubagentReport?: (event: RunSubagentReportEvent) => void;
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

  const startRun = useCallback((
    assistantId: string,
    body: { text?: string; retryMessageId?: string },
    /** send 必给;retry 不给(服务端沿用被重试那轮的模型)。 */
    modelId?: string
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

    const onEvent = (event: RunAgentStreamEvent): void => {
      const builder = builderRef.current;
      if (!builder) {
        return;
      }
      builder.push(event);
      // 只换 streaming 这一个引用 —— committed 数组完全不动
      setStreaming(builder.snapshot());
    };

    streamChat(request, {
      onRunStart(runId, returnedSessionId) {
        runIdRef.current = runId;
        sessionIdRef.current = returnedSessionId;
        setSessionId(returnedSessionId);
        queryClient.invalidateQueries({ queryKey: ["threads"] });
      },

      onEvent,

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
    });
  }, [queryClient, settleRun]);

  const sendMessage = useCallback((text: string, modelId: string) => {
    const trimmed = text.trim();
    if (isStreamingRef.current || trimmed.length === 0) {
      return;
    }

    const userMessage = createUserUIMessage(crypto.randomUUID(), trimmed);
    // 用户消息一次性进 committed;assistant 走 streaming 通道。
    setCommitted((prev) => [...prev, userMessage]);
    startRun(crypto.randomUUID(), { text: trimmed }, modelId);
  }, [startRun]);

  const regenerate = useCallback((messageId: string) => {
    if (isStreamingRef.current || !sessionIdRef.current) {
      return;
    }
    // 先移除被重试的那条(同槽位会重新落库一个 v2),再开一个流式气泡。
    setCommitted((prev) => prev.filter((m) => m.id !== messageId));
    startRun(crypto.randomUUID(), { retryMessageId: messageId });
  }, [startRun]);

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
    setCommitted([]);
    setSiblingIdsById({});
    setStreaming(null);
    sessionIdRef.current = null;
    setSessionId(null);
  }, []);

  const loadSession = useCallback((threadId: string) => {
    if (threadId === sessionIdRef.current) return;

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
  }, []);

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
    newConversation,
    loadSession
  };
}