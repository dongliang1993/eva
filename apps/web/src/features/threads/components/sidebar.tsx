import { PanelLeft, Settings, SquarePen } from "lucide-react";

import { isElectron } from "../../../shared/runtime";
import { useThreadList } from "../hooks/use-thread-list";

import { ThreadList } from "./thread-list";
import { WorkspaceAddPopover } from "./workspace-add-popover";

interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onNewChat: () => void;
  readonly onOpenSettings: () => void;
  readonly onSelectThread: (threadId: string) => void;
  /** 工作区模式下,在某工作区下新建 thread(首条消息后延迟绑定到该工作区)。 */
  readonly onNewThreadInWorkspace: (workspaceId: string) => void;
  /** 删除 thread(级联硬删,调用方善后: 删的是当前会话要退回新会话页)。 */
  readonly onDeleteThread: (threadId: string) => void;
  readonly sessionId: string | null;
}

/**
 * 侧栏: 折叠/展开由外层 Panel 宽度 + 下方 index.css 的 flex-grow transition 驱动,
 * 这里保持单一根容器 (背景跟随 Panel 动画), 内部按 collapsed 条件渲染内容。
 *
 * 只剩版式:会话数据与分组在 use-thread-list,列表在 thread-list,
 * 工作区区头在 workspace-add-popover。
 */
export function Sidebar({
  collapsed,
  onToggle,
  onNewChat,
  onOpenSettings,
  onSelectThread,
  onNewThreadInWorkspace,
  onDeleteThread,
  sessionId
}: SidebarProps) {
  const controller = useThreadList(onDeleteThread);

  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-border bg-sidebar">
      {/* Drag region spacer — 只在 Electron 下渲染(浏览器没有自定义标题栏),
          让内容避开窗口顶部。mac 的折叠/展开按钮已挪到红绿灯旁(chat-page 顶层
          fixed),这条只是占位。h-[42px] 与右侧内容区顶部拖拽栏同高,左右拉齐。 */}
      {isElectron() ? (
        <div className="titlebar-drag h-[42px] w-full shrink-0" />
      ) : null}

      {/* Header: brand + collapse toggle(Electron 下都不渲染:折叠按钮挪到红绿灯旁,品牌行也不展示) */}
      {!isElectron() && (
        <div
          className={`flex mb-2 shrink-0 items-center ${
            collapsed ? "justify-center py-3" : "justify-between px-3 py-2"
          }`}
        >
          {!collapsed && (
            <span className="text-base font-bold text-foreground select-none">Eva</span>
          )}
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            onClick={onToggle}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <PanelLeft size={18} />
          </button>
        </div>
      )}

      {/* New chat — 展开=全宽主按钮 / 折叠=居中图标 */}
      <div className={`shrink-0 ${collapsed ? "px-1 pb-1" : "px-3 pb-2"}`}>
        {collapsed ? (
          <button
            type="button"
            className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            onClick={onNewChat}
            title="New chat"
          >
            <SquarePen size={18} />
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={onNewChat}
            title="New chat"
          >
            <SquarePen size={16} />
            <span>新会话</span>
          </button>
        )}
      </div>

      {/* Thread 列表(按工作区分组, 展开) / 弹性占位 (折叠) */}
      {collapsed ? (
        <div className="flex-1" />
      ) : (
        <div className="flex-1 overflow-y-auto px-2">
          <WorkspaceAddPopover add={controller.workspaceAdd} />

          <ThreadList
            controller={controller}
            sessionId={sessionId}
            onSelectThread={onSelectThread}
            onNewThreadInWorkspace={onNewThreadInWorkspace}
          />
        </div>
      )}

      {/* Bottom: settings */}
      <div
        className={`shrink-0 ${
          collapsed
            ? "flex flex-col items-center gap-1 py-2"
            : "flex items-center px-2 py-2"
        }`}
      >
        <button
          type="button"
          className={`flex items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors ${
            collapsed ? "h-9 w-9 justify-center" : "flex-1 justify-start gap-2 px-2.5 py-2 text-sm"
          }`}
          onClick={onOpenSettings}
          title="设置"
        >
          <Settings size={16} />
          {!collapsed && <span>设置</span>}
        </button>
      </div>
    </div>
  );
}
