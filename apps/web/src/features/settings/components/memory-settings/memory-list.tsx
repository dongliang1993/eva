import { Brain, Check, Loader2, Pencil, RefreshCw, Search, Trash2, X } from "lucide-react";

import type { MemoryRecord } from "../../hooks/use-memories";

import { MetaChip } from "./memory-chips";

// ---------------------------------------------------------------------------
// 记忆列表 —— 搜索框 + 卡片列表(含行内编辑的呈现)。
//
// 编辑草稿 / 保存 / 删除都只是回调:谁在编、编到哪一步,由 index.tsx 持有(§6)。
// ---------------------------------------------------------------------------

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

const formatDateTime = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : DATE_TIME_FORMATTER.format(parsed);
};

function EmptyState({ isSearchActive }: { readonly isSearchActive: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-3 rounded-full bg-accent p-3 text-muted-foreground">
        <Brain size={20} />
      </div>
      <h3 className="text-sm font-semibold text-foreground">
        {isSearchActive ? "No matching memories" : "No memories yet"}
      </h3>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {isSearchActive
          ? "Try a different keyword."
          : "可以手动添加记忆，或开启自动提取，从后续对话中保存值得记住的事实。"}
      </p>
    </div>
  );
}

function MemoryCard({
  memory,
  isEditing,
  draftContent,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
  onDelete,
  isSaving,
  isDeleting
}: {
  readonly memory: MemoryRecord;
  readonly isEditing: boolean;
  readonly draftContent: string;
  readonly onDraftChange: (value: string) => void;
  readonly onEdit: (memory: MemoryRecord) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly onDelete: (memory: MemoryRecord) => void;
  readonly isSaving: boolean;
  readonly isDeleting: boolean;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <textarea
              className="min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-ring"
              value={draftContent}
              onChange={(e) => onDraftChange(e.target.value)}
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
              {memory.content}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-1.5">
            <MetaChip label="Category" value={memory.category} />
            <MetaChip label={memory.origin === "manual" ? "Manual" : "Auto"} value={memory.origin.replace("_", " ")} />
            <MetaChip label="Scope" value={memory.scopeKey} />
            <MetaChip label="Updated" value={formatDateTime(memory.updatedAt)} />
            {memory.sourceThreadId ? (
              <MetaChip label="Thread" value={memory.sourceThreadId} mono />
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {isEditing ? (
            <>
              <button
                type="button"
                className="rounded-lg border border-input p-2 text-foreground transition-colors hover:bg-accent"
                onClick={onCancel}
                disabled={isSaving}
                title="Cancel"
              >
                <X size={14} />
              </button>
              <button
                type="button"
                className="rounded-lg bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                onClick={onSave}
                disabled={isSaving}
                title="Save"
              >
                {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="rounded-lg border border-input p-2 text-foreground transition-colors hover:bg-accent"
                onClick={() => onEdit(memory)}
                disabled={isDeleting}
                title="Edit"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                className="rounded-lg border border-destructive/30 p-2 text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-60"
                onClick={() => onDelete(memory)}
                disabled={isDeleting}
                title="Delete"
              >
                {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function MemoryList({
  memories,
  searchInput,
  onSearchInputChange,
  isSearchActive,
  isLoading,
  isFetching,
  editingId,
  draftContent,
  onDraftChange,
  onEditStart,
  onEditCancel,
  onEditSave,
  onDelete,
  isUpdating,
  isDeleting
}: {
  readonly memories: readonly MemoryRecord[];
  readonly searchInput: string;
  readonly onSearchInputChange: (value: string) => void;
  readonly isSearchActive: boolean;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly editingId: string | null;
  readonly draftContent: string;
  readonly onDraftChange: (value: string) => void;
  readonly onEditStart: (memory: MemoryRecord) => void;
  readonly onEditCancel: () => void;
  readonly onEditSave: () => void;
  readonly onDelete: (memory: MemoryRecord) => void;
  readonly isUpdating: boolean;
  readonly isDeleting: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">记忆列表</h2>
        </div>

        <div className="flex items-center gap-2">
          {isFetching ? (
            <RefreshCw size={14} className="animate-spin text-muted-foreground" />
          ) : null}
        </div>
      </div>

      {/* Search bar */}
      <div className="border-b border-border px-5 py-3">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-ring"
            placeholder="Search memories..."
            value={searchInput}
            onChange={(e) => onSearchInputChange(e.target.value)}
          />
        </div>
      </div>

      {/* Memory list */}
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          Loading memories...
        </div>
      ) : memories.length > 0 ? (
        <div className="divide-y divide-border">
          {memories.map((memory) => (
            <MemoryCard
              key={memory.id}
              memory={memory}
              isEditing={editingId === memory.id}
              draftContent={editingId === memory.id ? draftContent : ""}
              onDraftChange={onDraftChange}
              onEdit={onEditStart}
              onCancel={onEditCancel}
              onSave={onEditSave}
              onDelete={onDelete}
              isSaving={isUpdating && editingId === memory.id}
              isDeleting={isDeleting}
            />
          ))}
        </div>
      ) : (
        <EmptyState isSearchActive={isSearchActive} />
      )}
    </div>
  );
}
