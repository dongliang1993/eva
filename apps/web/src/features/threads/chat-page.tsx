import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useChat } from "./hooks/use-chat";
import { useApprovals } from "./hooks/use-approvals";
import { apiFetch } from "../../shared/api/fetch";
import { setThreadWorkspace } from "../workspaces/api";
import { useSettings } from "../settings/hooks/use-settings";
import { Sidebar } from "./components/sidebar";
import { ChatView } from "./components/chat-view";
import { SubagentsProvider, useSubagentsStore } from "./components/subagents-context";
import { VersionActionsProvider } from "./components/version-actions-context";
import { ResizableSidebar } from "../../shared/ui/resizable-sidebar";
import type { ThreadSummary } from "../../types/api";

export function ChatPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  // 「始终允许」→ 只放开这一个工具的审批(T14:per-tool 白名单,不再是全局开关)。
  const settings = useSettings();
  const enableAutoApprove = useCallback(
    (toolName: string): Promise<void> | void => {
      const current = settings.data;
      if (!current) return;
      if (current.security.alwaysAllowTools.includes(toolName)) {
        return;
      }
      settings.saveSettings({
        ...current,
        security: {
          ...current.security,
          alwaysAllowTools: [...current.security.alwaysAllowTools, toolName]
        }
      });
    },
    [settings]
  );

  const approvals = useApprovals(enableAutoApprove);
  // S7:子代理视图 store(SSE 累积 + /subagent-messages 兜底)。
  const subagents = useSubagentsStore();
  const {
    messages,
    streamingMessage,
    isStreaming,
    sessionId,
    siblingIdsById,
    sendMessage,
    regenerate,
    switchVersion,
    stopStreaming,
    newConversation,
    loadSession
  } = useChat({
    onApproval: approvals.applyStreamEvent,
    onSubagent: subagents.applyStreamEvent,
    onSubagentReport: subagents.applyReport
  });

  // 会话切换 → store 归位,子代理卡片刷新兜底走对会话。
  useEffect(() => {
    subagents.setSessionId(sessionId);
  }, [sessionId, subagents]);

  // 会话切换/新会话时,从服务端对齐一次该会话下的待审批(不轮询)。事实源仍是 SSE。
  useEffect(() => approvals.refresh(sessionId), [sessionId, approvals.refresh]);

  // 已存在会话的 workspaceId 事实源是服务端 ThreadSummary(与侧栏共用同一 query 缓存,
  // React Query 去重,不会多发请求)。这里不另存一份。
  const { data: threads } = useQuery({
    queryKey: ["threads"],
    queryFn: () => apiFetch<readonly ThreadSummary[]>("/api/v1/threads"),
    refetchInterval: 10_000
  });
  const sessionWorkspaceId =
    threads?.find((t) => t.id === sessionId)?.workspaceId ?? null;

  // 新会话还没有 sessionId,没法 PUT —— 先把用户选的工作区暂存在这里。
  // 等第一条消息让服务端建出会话(sessionId 出现)后再 PUT。这是"还没有 session 可绑"的过渡态。
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId && pendingWorkspaceId !== null) {
      setThreadWorkspace(sessionId, pendingWorkspaceId)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ["threads"] });
          setPendingWorkspaceId(null);
        })
        .catch(() => {
          // 绑定失败静默:工作区仍停留在"未选择",用户下次切换可重试。
        });
    }
  }, [sessionId, pendingWorkspaceId, queryClient]);

  const displayWorkspaceId = sessionId ? sessionWorkspaceId : pendingWorkspaceId;

  const handleSelectWorkspace = useCallback(
    (workspaceId: string | null) => {
      if (sessionId) {
        setThreadWorkspace(sessionId, workspaceId)
          .then(() => queryClient.invalidateQueries({ queryKey: ["threads"] }))
          .catch(() => {});
      } else {
        setPendingWorkspaceId(workspaceId);
      }
    },
    [sessionId, queryClient]
  );

  // Load session from URL on mount (once)
  const threadIdFromUrl = searchParams.get("threadId");
  const initialLoadDone = useRef(false);

  useEffect(() => {
    if (threadIdFromUrl && !initialLoadDone.current) {
      initialLoadDone.current = true;
      loadSession(threadIdFromUrl);
    }
  }, [threadIdFromUrl, loadSession]);

  // When a new session is created (first message), sync to URL once
  const prevSessionId = useRef<string | null>(null);

  useEffect(() => {
    if (
      sessionId &&
      prevSessionId.current === null &&
      sessionId !== threadIdFromUrl
    ) {
      setSearchParams({ threadId: sessionId }, { replace: true });
    }
    prevSessionId.current = sessionId;
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const handleNewChat = useCallback(() => {
    newConversation();
    setPendingWorkspaceId(null);
    setSearchParams({}, { replace: true });
  }, [newConversation, setSearchParams]);

  const handleSelectThread = useCallback((threadId: string) => {
    setPendingWorkspaceId(null);
    setSearchParams({ threadId }, { replace: true });
    loadSession(threadId);
  }, [setSearchParams, loadSession]);

  const handleOpenSettings = useCallback(() => {
    navigate("/settings");
  }, [navigate]);

  return (
    <div className="h-screen bg-background text-foreground">
      <div className="titlebar-drag h-11 w-full fixed top-0 left-0 z-50" />
      <ResizableSidebar
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        sidebar={
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggle={handleToggleSidebar}
            onNewChat={handleNewChat}
            onOpenSettings={handleOpenSettings}
            onSelectThread={handleSelectThread}
            sessionId={sessionId}
          />
        }
      >
        <VersionActionsProvider value={{ siblingIdsById, isStreaming, onRegenerate: regenerate, onSwitchVersion: switchVersion }}>
          <SubagentsProvider value={subagents}>
            <ChatView
              messages={messages}
              streamingMessage={streamingMessage}
              isStreaming={isStreaming}
              selectedModel={selectedModel}
              onSend={(text) => sendMessage(text, selectedModel ?? undefined)}
              onStop={stopStreaming}
              onSelectModel={setSelectedModel}
              workspaceId={displayWorkspaceId}
              onSelectWorkspace={handleSelectWorkspace}
              sessionId={sessionId}
              pendingApprovals={approvals.pending}
              onApproveOnce={(callId) => approvals.decide(callId, true)}
              onDeny={(callId) => approvals.decide(callId, false)}
              onAllowAlways={(callId) => approvals.allowAlways(callId)}
            />
          </SubagentsProvider>
        </VersionActionsProvider>
      </ResizableSidebar>
    </div>
  );
}