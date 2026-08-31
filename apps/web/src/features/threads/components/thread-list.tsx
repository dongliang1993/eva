import { useState } from "react";

import type { ThreadSummary } from "../../../types/api";
import type { ThreadListController } from "../hooks/use-thread-list";

import { SessionStatusDot } from "./session-status-dot";
import { ThreadContextMenu } from "./thread-context-menu";
import { ThreadGroupHeader, WorkspaceRenameInput } from "./thread-group-header";

// ---------------------------------------------------------------------------
// 会话列表 —— 按工作区分组渲染。
//
// 分组、编辑态、请求都在 use-thread-list;这里只把它铺成行,并把点击/右键
// 变成 controller 上的一次调用。
// ---------------------------------------------------------------------------

/** 单条 thread 按钮(原扁平列表的样式原样保留)。右键出菜单(重命名 / 删除)。 */
function ThreadButton({
  thread,
  active,
  renaming,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete
}: {
  readonly thread: ThreadSummary;
  readonly active: boolean;
  readonly renaming: boolean;
  readonly onSelect: () => void;
  readonly onStartRename: () => void;
  readonly onCommitRename: (title: string) => void;
  readonly onCancelRename: () => void;
  readonly onDelete: () => void;
}) {
  const [draft, setDraft] = useState(thread.title);

  if (renaming) {
    return (
      <div
        className={`flex w-full items-center gap-2 rounded-lg py-2 pl-6 pr-3.5 ${
          active ? "bg-sidebar-active" : "bg-accent/50"
        }`}
      >
        <SessionStatusDot status={thread.status} />
        <input
          type="text"
          autoFocus
          className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-primary"
          defaultValue={thread.title}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const t = draft.trim();
              if (t && t !== thread.title) onCommitRename(t);
              else onCancelRename();
            }
            if (e.key === "Escape") onCancelRename();
          }}
          onBlur={onCancelRename}
        />
      </div>
    );
  }

  return (
    <ThreadContextMenu onStartRename={onStartRename} onDelete={onDelete}>
      <button
        type="button"
        className={`flex w-full items-center gap-2 rounded-lg py-2 pl-6 pr-3.5 text-left text-sm transition-colors ${
          active
            ? "bg-sidebar-active text-sidebar-active-foreground font-medium"
            : "text-foreground hover:bg-accent"
        }`}
        onClick={onSelect}
        title={thread.title}
      >
        <SessionStatusDot status={thread.status} />
        <span className="flex-1 truncate">{thread.title}</span>
      </button>
    </ThreadContextMenu>
  );
}

export function ThreadList({
  controller,
  sessionId,
  onSelectThread,
  onNewThreadInWorkspace
}: {
  readonly controller: ThreadListController;
  readonly sessionId: string | null;
  readonly onSelectThread: (threadId: string) => void;
  readonly onNewThreadInWorkspace: (workspaceId: string) => void;
}) {
  const renderThreadList = (list: readonly ThreadSummary[]) => (
    <div className="space-y-1">
      {list.map((thread) => (
        <ThreadButton
          key={thread.id}
          thread={thread}
          active={thread.id === sessionId}
          renaming={controller.renamingId === thread.id}
          onSelect={() => onSelectThread(thread.id)}
          onStartRename={() => controller.startRename(thread.id)}
          onCommitRename={(title) => controller.commitRename(thread.id, title)}
          onCancelRename={controller.cancelRename}
          onDelete={() => controller.confirmDelete(thread)}
        />
      ))}
    </div>
  );

  if (controller.groups.length === 0) {
    return <p className="px-2 py-4 text-xs text-muted-foreground">No conversations yet</p>;
  }

  return (
    <div>
      {controller.groups.map((group) => {
        const isCollapsed = controller.collapsedGroups.has(group.id);
        const isUncategorized = group.workspace === null;
        const ws = group.workspace;
        const renamingThisWs = ws !== null && controller.renamingWsId === ws.id;

        return (
          <div key={group.id}>
            {/* 组头: 重命名态是输入框;正常态整行可点折叠/展开,hover 出背景,
                工作区额外在行尾露「⋯」(重命名/删除)与「+」(新建 thread)。 */}
            {renamingThisWs && ws !== null ? (
              <WorkspaceRenameInput
                key={ws.id}
                initialName={ws.name}
                onCommit={(name) => controller.commitRenameWorkspace(ws.id, name)}
                onCancel={controller.cancelRenameWorkspace}
              />
            ) : (
              <ThreadGroupHeader
                group={group}
                isCollapsed={isCollapsed}
                onToggle={() => controller.toggleGroup(group.id)}
                onStartRenameWorkspace={controller.startRenameWorkspace}
                onDeleteWorkspace={controller.confirmDeleteWorkspace}
                onNewThreadInWorkspace={onNewThreadInWorkspace}
              />
            )}

            {/* 组内 thread(展开时) */}
            {!isCollapsed && group.threads.length > 0 && (
              <div className="mt-0.5">{renderThreadList(group.threads)}</div>
            )}
            {!isCollapsed && group.threads.length === 0 && !isUncategorized && (
              <p className="py-1 pl-6 text-xs text-muted-foreground/70">无会话</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
