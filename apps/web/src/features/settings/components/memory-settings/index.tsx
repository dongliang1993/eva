import { useDeferredValue, useState } from "react";
import {
  Brain,
  Check,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X
} from "lucide-react";

import { useSettings } from "../../hooks/use-settings";
import {
  useMemories,
  useMemoryCandidates,
  useMemoryStats,
  type MemoryCandidateRecord,
  type MemoryRecord
} from "../../hooks/use-memories";
import type { AppSettings } from "../../../../types/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

const formatDateTime = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : DATE_TIME_FORMATTER.format(parsed);
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <div className="pt-0.5">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${checked ? "bg-primary" : "bg-muted"
            } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          onClick={() => onChange(!checked)}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? "translate-x-4" : "translate-x-0.5"
              } mt-0.5`}
          />
        </button>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
    </label>
  );
}

function StatCard({
  value,
  label
}: {
  readonly value: number;
  readonly label: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-background px-4 py-4">
      <div className="text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function MetaChip({
  label,
  value,
  mono = false
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs text-muted-foreground ${mono ? "font-mono" : ""
        }`}
      title={value}
    >
      <span className="text-muted-foreground/70">{label}</span>
      <span className="truncate">{value}</span>
    </span>
  );
}

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

function MemoryCandidateCard({
  candidate,
  onAccept,
  onReject,
  disabled
}: {
  readonly candidate: MemoryCandidateRecord;
  readonly onAccept: (id: string) => void;
  readonly onReject: (id: string) => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{candidate.content}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <MetaChip label="Category" value={candidate.category} />
        <MetaChip label="Scope" value={candidate.scopeKey} />
        <MetaChip label="Confidence" value={`${candidate.confidence}%`} />
        <MetaChip label="Key" value={candidate.memoryKey} mono />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg border border-input px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:opacity-60"
          disabled={disabled}
          onClick={() => onReject(candidate.id)}
        >
          <X size={13} /> 忽略
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          disabled={disabled}
          onClick={() => onAccept(candidate.id)}
        >
          <Check size={13} /> 保存
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MemorySettings() {
  const [searchInput, setSearchInput] = useState("");
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const deferredSearchInput = useDeferredValue(searchInput);
  const activeSearchQuery = deferredSearchInput.trim();

  const { data: settings, saveSettingsAsync, isSaving: isSavingSettings } = useSettings();
  const memorySettings = settings?.memory;

  const {
    memories,
    isLoading,
    isFetching,
    error,
    createMemory,
    updateMemory,
    deleteMemory,
    isCreating,
    isUpdating,
    isDeleting
  } = useMemories(activeSearchQuery);

  const { data: stats } = useMemoryStats();
  const {
    candidates,
    acceptCandidate,
    rejectCandidate,
    isDeciding,
    error: candidateError,
    refresh: refreshCandidates
  } = useMemoryCandidates();

  // --- Settings mutation helpers ---

  const updateMemorySettings = async (patch: Partial<AppSettings["memory"]>) => {
    if (!settings) return;
    try {
      await saveSettingsAsync({
        ...settings,
        memory: { ...settings.memory, ...patch }
      });
    } catch (e) {
      setActionError(toErrorMessage(e));
    }
  };

  // --- Memory CRUD helpers ---

  const handleCreate = async () => {
    const content = newContent.trim();
    if (!content) return;
    setActionError(null);
    try {
      await createMemory({ content });
      setNewContent("");
    } catch (e) {
      setActionError(toErrorMessage(e));
    }
  };

  const handleEditStart = (memory: MemoryRecord) => {
    setActionError(null);
    setEditingId(memory.id);
    setDraftContent(memory.content);
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setDraftContent("");
  };

  const handleEditSave = async () => {
    if (!editingId) return;
    const content = draftContent.trim();
    if (!content) {
      setActionError("Memory cannot be empty.");
      return;
    }
    setActionError(null);
    try {
      await updateMemory({ id: editingId, content });
      setEditingId(null);
      setDraftContent("");
    } catch (e) {
      setActionError(toErrorMessage(e));
    }
  };

  const handleDelete = async (memory: MemoryRecord) => {
    if (!window.confirm(`Delete this memory?\n\n${memory.content}`)) return;
    setActionError(null);
    try {
      await deleteMemory(memory.id);
      if (editingId === memory.id) {
        setEditingId(null);
        setDraftContent("");
      }
    } catch (e) {
      setActionError(toErrorMessage(e));
    }
  };

  const handleCandidateDecision = async (id: string, decision: "accept" | "reject") => {
    setActionError(null);
    try {
      await (decision === "accept" ? acceptCandidate(id) : rejectCandidate(id));
    } catch (e) {
      setActionError(toErrorMessage(e));
    }
  };

  const queryError = error || candidateError ? toErrorMessage(error ?? candidateError) : null;
  const currentError = actionError ?? queryError;

  if (!settings || !memorySettings) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        <Loader2 size={16} className="mr-2 animate-spin" />
        Loading settings...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto pr-1 space-y-6">
        {/* ── Section 0: 记忆开关 ── */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-base font-semibold text-foreground">记忆功能</h2>

          <div className="mt-4 space-y-5">
            <Toggle
              checked={memorySettings.enabled}
              onChange={(v) => updateMemorySettings({ enabled: v })}
              label="启用可搜索记忆"
              description="允许 agent 主动保存和搜索跨会话事实。长期记忆文件始终可用。"
              disabled={isSavingSettings}
            />
            <Toggle
              checked={memorySettings.autoRetrieve}
              onChange={(v) => updateMemorySettings({ autoRetrieve: v })}
              label="自动检索"
              description="每轮开始前，从全局和当前工作区记忆中检索相关事实并注入上下文。"
              disabled={isSavingSettings || !memorySettings.enabled}
            />
            <Toggle
              checked={memorySettings.autoSummarize}
              onChange={(v) => updateMemorySettings({ autoSummarize: v })}
              label="自动提取"
              description="回复成功后使用工具模型提取值得跨会话保留的事实，会产生额外模型用量。"
              disabled={isSavingSettings || !memorySettings.enabled}
            />
            {memorySettings.autoSummarize ? (
              <label className="block pl-12">
                <span className="text-sm font-medium text-foreground">保存方式</span>
                <select
                  className="mt-2 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
                  value={memorySettings.autoSummarizeMode}
                  disabled={isSavingSettings}
                  onChange={(event) => updateMemorySettings({
                    autoSummarizeMode: event.target.value as "review" | "automatic"
                  })}
                >
                  <option value="review">先审核（推荐）</option>
                  <option value="automatic">高置信度自动保存</option>
                </select>
                <span className="mt-1 block text-xs text-muted-foreground">
                  自动模式只直接保存置信度不低于 85% 的候选，其余仍进入审核。
                </span>
              </label>
            ) : null}
          </div>
        </div>

        {memorySettings.autoSummarize || candidates.length > 0 ? (
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="text-base font-semibold text-foreground">待审核记忆</h2>
            <button type="button" className="mt-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void refreshCandidates()}>刷新候选</button>
            <p className="mt-1 text-xs text-muted-foreground">
              这些事实来自已完成的对话；确认后才会进入跨会话检索。
            </p>
            <div className="mt-4 space-y-3">
              {candidates.length === 0 ? <p className="text-sm text-muted-foreground">暂无待审核记忆。</p> : null}
              {candidates.map((candidate) => (
                <MemoryCandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  disabled={isDeciding}
                  onAccept={(id) => void handleCandidateDecision(id, "accept")}
                  onReject={(id) => void handleCandidateDecision(id, "reject")}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* ── Section: 统计 ── */}
        {stats ? (
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-base font-semibold text-foreground">统计</h2>

            <div className="grid grid-cols-3 gap-4">
              <StatCard value={stats.count} label="记忆总数" />
              <StatCard value={stats.autoGenerated} label="自动 / Agent 保存" />
              <StatCard value={stats.manualAdded} label="手动添加" />
            </div>


          </div>
        ) : null}

        {/* ── Section 3: 手动添加 ── */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-base font-semibold text-foreground">添加记忆</h2>

          <textarea
            className="mt-4 min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-ring"
            placeholder="输入想让 AI 记住的内容..."
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />

          <button
            type="button"
            className="mt-3 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={handleCreate}
            disabled={newContent.trim().length === 0 || isCreating}
          >
            <span className="inline-flex items-center gap-1.5">
              {isCreating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              添加记忆
            </span>
          </button>
        </div>

        {/* ── Error display ── */}
        {currentError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {currentError}
          </div>
        ) : null}

        {/* ── Section 4: Search + Memory List ── */}
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
                onChange={(e) => setSearchInput(e.target.value)}
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
                  onDraftChange={setDraftContent}
                  onEdit={handleEditStart}
                  onCancel={handleEditCancel}
                  onSave={handleEditSave}
                  onDelete={handleDelete}
                  isSaving={isUpdating && editingId === memory.id}
                  isDeleting={isDeleting}
                />
              ))}
            </div>
          ) : (
            <EmptyState isSearchActive={activeSearchQuery.length > 0} />
          )}
        </div>
      </div>
    </div>
  );
}
