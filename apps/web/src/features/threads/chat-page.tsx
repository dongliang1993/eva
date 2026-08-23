import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelLeft } from "lucide-react";

import { useChat } from "./hooks/use-chat";
import { useApprovals } from "./hooks/use-approvals";
import { apiFetch } from "../../shared/api/fetch";
import { setThreadWorkspace } from "../workspaces/api";
import { grantApprovalPolicy } from "./api";
import { Sidebar } from "./components/sidebar";
import { ChatView } from "./components/chat-view";
import type { ChatInputRejection } from "./components/chat-input";
import { SubagentsProvider, useSubagentsStore } from "./components/subagents-context";
import { VersionActionsProvider } from "./components/version-actions-context";
import { ResizableSidebar } from "../../shared/ui/resizable-sidebar";
import { isElectron, isMacDesktop } from "../../shared/runtime";
import type { ThreadSummary } from "../../types/api";

export function ChatPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  // 「始终允许」→ 后端选精确 policy key 落 thread 作用域 policy(T31,不再是全局白名单)。
  // sessionId 在 useChat 之后才拿到,所以这里用 ref 读最新值(不挂进依赖)。
  const sessionIdRefForGrant = useRef<string | null>(null);
  const grantPolicy = useCallback(
    async (tool: string, args: Record<string, unknown>): Promise<void> => {
      const sessionId = sessionIdRefForGrant.current;
      if (!sessionId) return; // 新建会话还没 sessionId —— 等 run_start 带回,这次先不记
      await grantApprovalPolicy(tool, sessionId, args);
    },
    []
  );

  /**
   * 这一句被服务端 409 挡了(会话里还有一轮在飞)。
   *
   * SSE 断连不再 abort run 之后这是正常路径:刷新完立刻又发一句,上一轮还在跑。
   * hook 已经替我们挂回了在跑的那个 run —— 页面这边只负责把话还给用户、说清原因。
   */
  const [rejection, setRejection] = useState<ChatInputRejection | null>(null);

  const handleRejected = useCallback((text: string | undefined) => {
    setRejection({
      ...(text !== undefined ? { text } : {}),
      message: "这个会话还有一轮在运行,已挂回那一轮 —— 等它跑完或点停止后再发。"
    });
  }, []);

  const clearRejection = useCallback(() => setRejection(null), []);

  const approvals = useApprovals(grantPolicy);
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
    onSubagentReport: subagents.applyReport,
    onRejected: handleRejected
  });

  // 会话切换 → store 归位,子代理卡片刷新兜底走对会话。
  useEffect(() => {
    subagents.setSessionId(sessionId);
  }, [sessionId, subagents]);

  // 会话切换/新会话时,从服务端对齐一次该会话下的待审批(不轮询)。事实源仍是 SSE。
  useEffect(() => approvals.refresh(sessionId), [sessionId, approvals.refresh]);

  // T31:grant 路由要当前 sessionId,同步进 ref(不触发 grantPolicy 重建)。
  useEffect(() => {
    sessionIdRefForGrant.current = sessionId;
  }, [sessionId]);

  // 已存在会话的 workspaceId 事实源是服务端 ThreadSummary(与侧栏共用同一 query 缓存,
  // React Query 去重,不会多发请求)。这里不另存一份。
  const { data: threads } = useQuery({
    queryKey: ["threads"],
    queryFn: () => apiFetch<readonly ThreadSummary[]>("/api/v1/threads"),
    refetchInterval: 10_000
  });
  const sessionWorkspaceId =
    threads?.find((t) => t.id === sessionId)?.workspaceId ?? null;

  // 模型是 per-thread 的:切换会话时把服务端存的 model(最近一轮 run 落库的)
  // 回填到选择器;新建会话(sessionId 为 null)时清回空,交给 SelectModel 默认第一个。
  // 只在 sessionId 变化那一刻同步 —— threads 10s 轮询会把 updateModel 的落库结果带回来,
  // 若跟着 currentThreadModel 走,用户手选会被轮询闪回覆盖。
  const syncedSessionRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (sessionId === syncedSessionRef.current) return;
    if (threads === undefined) return; // 列表还没到,等下一轮

    if (sessionId === null) {
      syncedSessionRef.current = sessionId;
      setSelectedModel(null);
      return;
    }

    const thread = threads.find((t) => t.id === sessionId);
    if (thread === undefined) {
      // 新会话刚建,threads 缓存还是旧的(不含它)—— 别用 null 盖掉用户刚选的
      // 模型,等下一轮 invalidate 把新 thread 带回来再回填。
      return;
    }

    syncedSessionRef.current = sessionId;
    // 新会话的 model 是 per-run 的,第一条消息落库前 DB 里可能是 null —— 同样别盖。
    if (thread.model !== null) {
      setSelectedModel(thread.model);
    }
  }, [sessionId, threads]);

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
    setRejection(null);
    setSearchParams({}, { replace: true });
  }, [newConversation, setSearchParams]);

  // 工作区模式下,在某工作区下新建 thread:清成新会话,工作区暂存 pending,
  // 首条消息让服务端建出会话后经既有 effect(见上)PUT 绑定到该工作区。
  const handleNewThreadInWorkspace = useCallback(
    (workspaceId: string) => {
      newConversation();
      setPendingWorkspaceId(workspaceId);
      setRejection(null);
      setSearchParams({}, { replace: true });
    },
    [newConversation, setSearchParams]
  );

  const handleSelectThread = useCallback((threadId: string) => {
    setPendingWorkspaceId(null);
    // 提示是"上一句没发出去"的说明,换会话就过期了。
    setRejection(null);
    setSearchParams({ threadId }, { replace: true });
    loadSession(threadId);
  }, [setSearchParams, loadSession]);

  // 删除 thread 的善后: 删的是当前正在看的会话 → 退回新会话页(清态+清 URL)。
  // 删别的会话不影响当前视图,只靠 [threads] invalidate 刷新侧栏即可。
  const handleDeleteThread = useCallback(
    (threadId: string) => {
      if (threadId === sessionId) {
        newConversation();
        setPendingWorkspaceId(null);
        setRejection(null);
        setSearchParams({}, { replace: true });
      }
    },
    [sessionId, newConversation, setSearchParams]
  );

  const handleOpenSettings = useCallback(() => {
    navigate("/settings");
  }, [navigate]);

  // eva:// 深链(thread 跳转 / 打开设置)。仅桌面端(preload 注入)有,浏览器下 electronAPI undefined。
  useEffect(() => {
    if (!isElectron()) return;

    const unbind = window.electronAPI!.onDeepLink((url) => {
      const thread = url.match(/^eva:\/\/thread\/([\w-]+)/);
      if (thread) {
        setPendingWorkspaceId(null);
        setRejection(null);
        setSearchParams({ threadId: thread[1]! }, { replace: true });
        loadSession(thread[1]!);
        return;
      }
      if (url.startsWith("eva://settings")) {
        navigate("/settings");
      }
    });

    return unbind;
  }, [loadSession, navigate, setSearchParams]);

  return (
    <div className="h-screen bg-background text-foreground">
      {/* mac 桌面:折叠按钮固定在红绿灯右侧,与侧栏折叠态无关。它就是普通按钮,
          不进任何 titlebar-drag 容器;外层 fixed 壳只负责定位(pointer-events-none,
          不拦截),按钮自身可点。标题栏拖拽由右侧内容区那条 42px 拖拽栏承担。
          z-[60] + 壳自身 relative:压过侧栏/右侧那两条 42px titlebar-drag(drag 区),
          否则 Electron 把按钮那片当拖拽、吞掉点击。 */}
      {isMacDesktop() ? (
        <div className="pointer-events-none fixed left-[78px] top-0 z-[60] flex h-[42px] w-9 items-center justify-center">
          <button
            type="button"
            className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            onClick={handleToggleSidebar}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <PanelLeft size={15} />
          </button>
        </div>
      ) : null}
      <ResizableSidebar
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        collapsedSizePixels={isElectron() ? 0 : 48}
        sidebar={
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggle={handleToggleSidebar}
            onNewChat={handleNewChat}
            onOpenSettings={handleOpenSettings}
            onSelectThread={handleSelectThread}
            onNewThreadInWorkspace={handleNewThreadInWorkspace}
            onDeleteThread={handleDeleteThread}
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
              onSend={(text) => {
                // ChatInput 在 selectedModel 为空时禁用发送,所以这里必有模型。
                if (selectedModel === null) return;
                sendMessage(text, selectedModel);
              }}
              onStop={stopStreaming}
              onSelectModel={setSelectedModel}
              workspaceId={displayWorkspaceId}
              onSelectWorkspace={handleSelectWorkspace}
              sessionId={sessionId}
              pendingApprovals={approvals.pending}
              resolvedApprovals={approvals.resolved}
              onApproveOnce={(callId) => approvals.decide(callId, true)}
              onDeny={(callId) => approvals.decide(callId, false)}
              onAllowAlways={(callId) => approvals.allowAlways(callId)}
              rejection={rejection}
              onRejectionSeen={clearRejection}
            />
          </SubagentsProvider>
        </VersionActionsProvider>
      </ResizableSidebar>
    </div>
  );
}