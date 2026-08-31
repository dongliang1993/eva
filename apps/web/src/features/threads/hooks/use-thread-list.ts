import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "../../../shared/api/fetch";
import type { ThreadSummary, Workspace } from "../../../types/api";
import { extractErrorText } from "../../workspaces/api";
import { pickWorkspaceDirectory } from "../../workspaces/pick-directory";
import { useWorkspaces } from "../../workspaces/hooks/use-workspaces";
import { deleteThread, renameThread } from "../api";

// ---------------------------------------------------------------------------
// 侧栏的数据层 —— 会话列表、工作区、两边的重命名/删除,以及「按工作区分组」的投影。
//
// 组件只读这里给出的 groups 与编辑态,不自己发请求;侧栏因此只剩版式(§7.18 P2-4)。
// ---------------------------------------------------------------------------

/** 「未分类」组的固定 id(workspace 为 null 的桶)。 */
const UNCATEGORIZED_ID = "__uncategorized__";

export interface ThreadGroup {
  readonly id: string;
  readonly workspace: Workspace | null;
  readonly threads: readonly ThreadSummary[];
  /** 组内最新 thread 的 updatedAt(组排序用);空组为 ""。 */
  readonly latest: string;
}

export function useThreadList(
  /** 删除 thread 后的善后(删的是当前会话要退回新会话页)。 */
  onDeleteThread: (threadId: string) => void
) {
  const { data } = useQuery({
    queryKey: ["threads"],
    queryFn: () => apiFetch<readonly ThreadSummary[]>("/api/v1/threads"),
    refetchInterval: 10_000
  });
  const { workspaces, add, rename: renameWs, remove: removeWorkspace } = useWorkspaces();

  const threads = useMemo(() => data ?? [], [data]);

  // 重命名 thread(右键 → 内联输入框)。renamingId = 正在编辑的 thread id。
  const queryClient = useQueryClient();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameThread(id, title),
    onSuccess: () => {
      setRenamingId(null);
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
    },
    onError: () => setRenamingId(null)
  });

  // 删除 thread: 级联硬删(messages/runs/usage_records 都 cascade),先确认再删。
  const remove = useMutation({
    mutationFn: (id: string) => deleteThread(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      onDeleteThread(id); // 父组件善后: 删的是当前会话就退回新会话页
    }
  });
  const confirmDelete = (thread: ThreadSummary) => {
    if (
      window.confirm(
        `删除会话「${thread.title}」？\n\n会一并删除它的所有消息和运行记录,不可恢复。`
      )
    ) {
      remove.mutate(thread.id);
    }
  };

  // 重命名 / 删除工作区(hover 组头「⋯」菜单 → 内联输入 / 确认后删)。删除走的是
  // FK SET NULL —— 组下 thread 不会丢,只会被解绑回「未分类」。rename/remove 直接
  // 复用 useWorkspaces 的 mutation(成功即失效 workspaces 查询);这里只管编辑态。
  const [renamingWsId, setRenamingWsId] = useState<string | null>(null);
  const commitRenameWorkspace = (id: string, name: string) =>
    renameWs.mutate(
      { id, name },
      { onSettled: () => setRenamingWsId(null) }
    );
  const confirmDeleteWorkspace = (ws: Workspace) => {
    const count = threads.filter((t) => t.workspaceId === ws.id).length;
    const detail =
      count > 0
        ? `\n\n它下面的 ${count} 个会话不会被删除,只会移回「未分类」。`
        : "";
    if (window.confirm(`删除工作区「${ws.name}」？${detail}`)) {
      removeWorkspace.mutate(ws.id);
    }
  };

  // 折叠的组 id 集合(默认全部展开)。
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (id: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 按 workspaceId 分桶 + 排序:「未分类」在最前(默认/未绑定的会话),其后是有
  // thread 的工作区(按各自最新 thread 倒序),空工作区垫底。脏数据(指向已删
  // workspace)归未分类。
  const groups = useMemo<readonly ThreadGroup[]>(() => {
    const known = new Set(workspaces.map((w) => w.id));
    const byWorkspace = new Map<string, ThreadSummary[]>();
    const uncategorized: ThreadSummary[] = [];
    for (const t of threads) {
      if (t.workspaceId && known.has(t.workspaceId)) {
        const list = byWorkspace.get(t.workspaceId) ?? [];
        list.push(t);
        byWorkspace.set(t.workspaceId, list);
      } else {
        uncategorized.push(t);
      }
    }

    const latestOf = (list: readonly ThreadSummary[]): string =>
      list.reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), "");

    const withThreads: ThreadGroup[] = [];
    const empty: ThreadGroup[] = [];
    for (const w of workspaces) {
      const list = byWorkspace.get(w.id) ?? [];
      const group: ThreadGroup = {
        id: w.id,
        workspace: w,
        threads: list,
        latest: latestOf(list)
      };
      (list.length > 0 ? withThreads : empty).push(group);
    }
    withThreads.sort((a, b) => (a.latest < b.latest ? 1 : -1));

    const result: ThreadGroup[] = [];
    if (uncategorized.length > 0) {
      result.push({
        id: UNCATEGORIZED_ID,
        workspace: null,
        threads: uncategorized,
        latest: latestOf(uncategorized)
      });
    }
    result.push(...withThreads, ...empty);
    return result;
  }, [threads, workspaces]);

  // 新建工作区(Electron 原生选目录 / 浏览器 File System Access 选目录 / 都不行才手输)。
  const [addOpen, setAddOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);

  const submitWorkspacePath = async (pathValue: string) => {
    if (!pathValue.trim()) return;
    setAddSubmitting(true);
    setAddError(null);
    try {
      await add.mutateAsync({ path: pathValue.trim() });
      setAddOpen(false);
      setPathInput("");
    } catch (err) {
      setAddError(extractErrorText(err));
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleAddWorkspace = async () => {
    // Electron IPC → server 弹系统框,拿到绝对路径直接建;取消静默;只有都
    // 弹不出才回落手输路径 Popover。
    const result = await pickWorkspaceDirectory();
    if (result.kind === "picked") {
      await submitWorkspacePath(result.path);
      return;
    }
    if (result.kind === "cancelled") return;
    setAddOpen(true);
    setAddError(null);
  };

  return {
    groups,
    collapsedGroups,
    toggleGroup,
    renamingId,
    startRename: setRenamingId,
    cancelRename: () => setRenamingId(null),
    commitRename: (id: string, title: string) => rename.mutate({ id, title }),
    confirmDelete,
    renamingWsId,
    startRenameWorkspace: setRenamingWsId,
    cancelRenameWorkspace: () => setRenamingWsId(null),
    commitRenameWorkspace,
    confirmDeleteWorkspace,
    /** 新建工作区:原生选目录优先,弹不出来才开手输 Popover。 */
    workspaceAdd: {
      open: addOpen,
      setOpen: (open: boolean) => {
        setAddOpen(open);
        if (!open) setAddError(null);
      },
      pathInput,
      setPathInput,
      error: addError,
      submitting: addSubmitting,
      submitPath: submitWorkspacePath,
      start: handleAddWorkspace
    }
  };
}

export type ThreadListController = ReturnType<typeof useThreadList>;
