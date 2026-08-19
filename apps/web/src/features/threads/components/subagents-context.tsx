import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import type { RunSubagentReportEvent, RunSubagentUpdateEvent } from "@eva/shared";
import { UiMessageBuilder, type EvaUIMessage } from "@eva/shared";

import { fetchSubagentMessages } from "../api";
import type { SubagentMessage } from "../../../types/api";

/** 一次子代理任务的视图状态。live(SSE 累积)+ refresh(/subagent-messages 兜底)。 */
export interface SubagentView {
  readonly status: "running" | "done" | "failed";
  readonly subagentType: string;
  /** 3-5 词任务名 —— 卡片标题用它区分并行派出的多个子代理。 */
  readonly description: string;
  /** 子代理主动交付的结论(report 工具)。可多条。 */
  readonly reports: readonly string[];
  readonly result: string | null;
  readonly error: string | null;
  /** 子代理进程累积出的 assistant 消息(含 tool call / result 轨迹)。 */
  readonly message: EvaUIMessage;
  /** 是否还收到 streaming 尾部(刷新后已是终态,false)。 */
  readonly live: boolean;
}

export interface SubagentsStore {
  /** parentToolCallId(= Task 调用的 toolCallId) → 子代理视图。 */
  readonly byToolCallId: Readonly<Record<string, SubagentView>>;
  /** SSE subagent_update 累积 —— 给 useChat 的 onSubagent 喂。 */
  readonly applyStreamEvent: (event: RunSubagentUpdateEvent) => void;
  /** SSE subagent_report —— 卡片即时显示"已回报",不必等注入。 */
  readonly applyReport: (event: RunSubagentReportEvent) => void;
  /** 会话 id 变更后刷新归属(页面/会话切换后用 threadId 兜底)。 */
  readonly setSessionId: (sessionId: string | null) => void;
  /** 卡片展开按 toolCallId 从 /subagent-messages 拉已落库的子代理进程。 */
  readonly loadForToolCall: (toolCallId: string) => void;
}

/** /subagent-messages 的返回 → 卡片可渲染的视图。 */
const toView = (msg: SubagentMessage): SubagentView => {
  // 落库的消息只有 brief(user)+assistant 两条;卡片展开区更需要 assistant 那条。
  const assistant = [...msg.messages].reverse().find((m) => m.role === "assistant");
  return {
    status: msg.status,
    subagentType: msg.subagentType,
    description: msg.description,
    reports: msg.result !== null ? [msg.result] : [],
    result: msg.result,
    error: msg.error,
    message:
      assistant?.message ?? {
        id: `subagent-${msg.taskId}`,
        role: "assistant",
        parts: []
      },
    live: false
  };
};

/**
 * 持有主对话里所有 Task 卡片的子代理视图 store。
 *
 * 数据两源合并:
 * - live:本 run 的 SSE subagent_update,按 parentToolCallId(== Task 调用的
 *   toolCallId)累积出 message 与状态;
 * - refresh:页面刷新/切换后任务已落库,卡片展开时经 loadForThread 走
 *   /subagent-messages 取那棵子树。
 */
export function useSubagentsStore(): SubagentsStore {
  const [byToolCallId, setByToolCallId] = useState<
    Readonly<Record<string, SubagentView>>
  >({});
  const [sessionId, setSessionId] = useState<string | null>(null);
  const buildersRef = useRef<Map<string, UiMessageBuilder>>(new Map());

  return useMemo<SubagentsStore>(() => {
    const applyStreamEvent = (event: RunSubagentUpdateEvent): void => {
      const key = event.parentToolCallId;
      setByToolCallId((prev) => {
        const existing = prev[key];
        // 已 settle 的 live 不再收新帧 —— finish 后的冗余帧直接忽略。
        if (existing && existing.status !== "running") {
          return prev;
        }

        let builder = buildersRef.current.get(key);
        if (!builder) {
          builder = new UiMessageBuilder(`subagent-${event.taskId}`);
          buildersRef.current.set(key, builder);
        }
        builder.push(event.event);

        const base = {
          subagentType: event.subagentType,
          description: event.description,
          reports: existing?.reports ?? [],
          status: "running" as const,
          result: null as string | null,
          error: null as string | null
        };

        if (event.event.type === "finish") {
          return {
            ...prev,
            [key]: {
              ...base,
              status: "done",
              result: event.event.text,
              message: builder.build(),
              live: true
            }
          };
        }
        if (event.event.type === "error") {
          return {
            ...prev,
            [key]: {
              ...base,
              status: "failed",
              error: event.event.message,
              message: builder.build(),
              live: true
            }
          };
        }
        return {
          ...prev,
          [key]: { ...base, message: builder.snapshot(), live: true }
        };
      });
    };

    const applyReport = (event: RunSubagentReportEvent): void => {
      const key = event.parentToolCallId;
      setByToolCallId((prev) => {
        const existing = prev[key];
        return {
          ...prev,
          [key]: {
            status: existing?.status ?? "running",
            subagentType: existing?.subagentType ?? "explorer",
            description: event.description,
            reports: [...(existing?.reports ?? []), event.output],
            result: existing?.result ?? null,
            error: existing?.error ?? null,
            message: existing?.message ?? {
              id: `subagent-${event.taskId}`,
              role: "assistant",
              parts: []
            },
            live: true
          }
        };
      });
    };

    const loadForToolCall = async (toolCallId: string): Promise<void> => {
      const threadId = sessionId;
      if (!threadId) return;
      const existing = byToolCallId[toolCallId];
      // 已有 live 且还在跑 → 不覆盖这条最新的。
      if (existing && existing.status === "running" && existing.live) {
        return;
      }

      try {
        const fetched = await fetchSubagentMessages(threadId, toolCallId);
        setByToolCallId((prev) =>
          prev[toolCallId]?.live === true && prev[toolCallId].status === "running"
            ? prev
            : { ...prev, [toolCallId]: toView(fetched) }
        );
      } catch {
        // 拉取失败(任务未落库/还没 finish)保留现状,卡片仍可展开 live 数据。
      }
    };

    return { byToolCallId, applyStreamEvent, applyReport, setSessionId, loadForToolCall };
  }, [byToolCallId, sessionId]);
}

const SubagentsContext = createContext<SubagentsStore | null>(null);

export function SubagentsProvider({
  value,
  children
}: {
  readonly value: SubagentsStore;
  readonly children: ReactNode;
}) {
  return (
    <SubagentsContext.Provider value={value}>
      {children}
    </SubagentsContext.Provider>
  );
}

/** 卡片层读子代理视图(ctx 已由 ChatPage 用 useSubagentsStore 喂好)。 */
export const useSubagents = (): SubagentsStore => {
  const ctx = useContext(SubagentsContext);
  if (!ctx) {
    throw new Error("useSubagents must be used within SubagentsProvider");
  }
  return ctx;
};