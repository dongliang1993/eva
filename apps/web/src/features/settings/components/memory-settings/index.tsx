import { useDeferredValue, useState } from "react";
import { Loader2 } from "lucide-react";

import { useSettings } from "../../hooks/use-settings";
import {
  useMemories,
  useMemoryCandidates,
  useMemoryStats,
  type MemoryRecord
} from "../../hooks/use-memories";
import type { AppSettings } from "../../../../types/api";

import { MemoryCandidateList } from "./memory-candidates";
import { MemoryEditor } from "./memory-editor";
import { MemoryList } from "./memory-list";
import { MemoryPreferences } from "./memory-preferences";
import { MemoryStats } from "./memory-stats";

// ---------------------------------------------------------------------------
// 记忆设置页 —— 只剩「状态 + 请求 + 版式」。
//
// 五块展示分别在 memory-preferences / memory-candidates /
// memory-stats / memory-editor / memory-list;
// 所有可变状态与所有 mutation 都留在这里,子组件只收 props 发 intent(§7.19)。
// ---------------------------------------------------------------------------

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

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
    error: candidateError,
    refresh: refreshCandidates,
    acceptCandidate,
    rejectCandidate,
    isDeciding
  } = useMemoryCandidates();

  // --- Settings mutation helpers ---

  const updateMemorySettings = async (patch: Partial<AppSettings["memory"]>) => {
    if (!settings) return;
    setActionError(null);
    try {
      await saveSettingsAsync({
        ...settings,
        memory: { ...settings.memory, ...patch }
      });
    } catch (e) {
      setActionError(toErrorMessage(e));
    }
  };

  // --- Memory CRUD handlers ---

  const handleCreate = async () => {
    setActionError(null);
    try {
      await createMemory({ content: newContent });
      setNewContent("");
    } catch (e) {
      setActionError(toErrorMessage(e));
    }
  };

  const handleEditStart = (memory: MemoryRecord) => {
    setEditingId(memory.id);
    setDraftContent(memory.content);
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setDraftContent("");
  };

  const handleEditSave = async () => {
    if (!editingId) return;
    setActionError(null);
    try {
      await updateMemory({ id: editingId, content: draftContent });
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
        <MemoryPreferences
          settings={settings}
          isSaving={isSavingSettings}
          onPatch={updateMemorySettings}
        />

        {memorySettings.autoSummarize || candidates.length > 0 ? (
          <MemoryCandidateList
            candidates={candidates}
            isDeciding={isDeciding}
            onRefresh={() => void refreshCandidates()}
            onDecide={(id, decision) => void handleCandidateDecision(id, decision)}
          />
        ) : null}

        {stats ? <MemoryStats stats={stats} /> : null}

        <MemoryEditor
          content={newContent}
          onContentChange={setNewContent}
          onSubmit={handleCreate}
          isCreating={isCreating}
        />

        {/* ── Error display ── */}
        {currentError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {currentError}
          </div>
        ) : null}

        <MemoryList
          memories={memories}
          searchInput={searchInput}
          onSearchInputChange={setSearchInput}
          isSearchActive={activeSearchQuery.length > 0}
          isLoading={isLoading}
          isFetching={isFetching}
          editingId={editingId}
          draftContent={draftContent}
          onDraftChange={setDraftContent}
          onEditStart={handleEditStart}
          onEditCancel={handleEditCancel}
          onEditSave={handleEditSave}
          onDelete={handleDelete}
          isUpdating={isUpdating}
          isDeleting={isDeleting}
        />
      </div>
    </div>
  );
}
