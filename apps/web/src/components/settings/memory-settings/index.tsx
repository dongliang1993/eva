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

import { apiFetch } from "../../../api/fetch";
import { useSettings } from "../../../hooks/use-settings";
import {
  useMemories,
  useMemoryStats,
  type MemoryRecord
} from "../../../hooks/use-memories";
import type { AppSettings } from "../../../types/api";

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
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${
            checked ? "bg-primary" : "bg-muted"
          } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          onClick={() => onChange(!checked)}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
              checked ? "translate-x-4" : "translate-x-0.5"
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

function SliderField({
  label,
  description,
  value,
  min,
  max,
  step,
  formatValue,
  onChange
}: {
  readonly label: string;
  readonly description?: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly formatValue?: (v: number) => string;
  readonly onChange: (value: number) => void;
}) {
  const display = formatValue ? formatValue(value) : String(value);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-sm tabular-nums text-muted-foreground">{display}</span>
      </div>
      {description ? (
        <p className="mb-2 text-xs text-muted-foreground">{description}</p>
      ) : null}
      <input
        type="range"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </div>
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
      className={`inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs text-muted-foreground ${
        mono ? "font-mono" : ""
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
          : "Memories will be created from your conversations automatically, or you can add them manually."}
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
            <MetaChip
              label={memory.origin === "tool_saved" ? "Auto" : "Manual"}
              value={memory.origin === "tool_saved" ? "auto-generated" : "manually added"}
            />
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

  const queryError = error ? toErrorMessage(error) : null;
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

        {/* ── Section 1: Memory Settings ── */}
        <div className="rounded-xl border border-border bg-card p-6 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-foreground">Memory Settings</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Control how the agent stores and retrieves long-term memory.
            </p>
          </div>

          <Toggle
            checked={memorySettings.enabled}
            onChange={(v) => updateMemorySettings({ enabled: v })}
            label="Enable Memory"
            description="When enabled, the agent can remember important information across conversations and use it to provide more personalized responses."
            disabled={isSavingSettings}
          />

          {memorySettings.enabled ? (
            <>
              <div className="border-t border-border pt-5 space-y-5">
                <h3 className="text-sm font-medium text-foreground">Retrieval</h3>

                <Toggle
                  checked={memorySettings.autoRetrieve}
                  onChange={(v) => updateMemorySettings({ autoRetrieve: v })}
                  label="Auto-retrieve Memories"
                  description="Automatically search and inject relevant memories into context at the start of each conversation turn."
                  disabled={isSavingSettings}
                />

                {memorySettings.autoRetrieve ? (
                  <div className="pl-12 space-y-5">
                    <Toggle
                      checked={memorySettings.queryRewriting}
                      onChange={(v) => updateMemorySettings({ queryRewriting: v })}
                      label="Query Rewriting"
                      description="Use the tool model to rewrite your message into a better search query before retrieving memories."
                      disabled={isSavingSettings}
                    />

                    <SliderField
                      label="Max Retrieved Memories"
                      description="Maximum number of memories injected into the prompt context per turn (1-20)."
                      value={memorySettings.maxRetrievedMemories}
                      min={1}
                      max={20}
                      onChange={(v) => updateMemorySettings({ maxRetrievedMemories: v })}
                    />

                    <SliderField
                      label="Similarity Threshold"
                      description="Minimum similarity score for retrieved memories. Higher values mean stricter matching."
                      value={memorySettings.similarityThreshold}
                      min={0}
                      max={1}
                      step={0.05}
                      formatValue={(v) => `${Math.round(v * 100)}%`}
                      onChange={(v) => updateMemorySettings({ similarityThreshold: v })}
                    />
                  </div>
                ) : null}
              </div>

              <div className="border-t border-border pt-5 space-y-5">
                <h3 className="text-sm font-medium text-foreground">Auto-summarize</h3>

                <Toggle
                  checked={memorySettings.autoSummarize}
                  onChange={(v) => updateMemorySettings({ autoSummarize: v })}
                  label="Auto-summarize Conversations"
                  description="Automatically extract and store important information from conversations as new memories."
                  disabled={isSavingSettings}
                />
              </div>

              <div className="border-t border-border pt-5 space-y-5">
                <h3 className="text-sm font-medium text-foreground">Models</h3>

                <div className="space-y-3 rounded-lg border border-border/50 bg-background/50 p-4">
                  <div className="text-sm font-medium text-foreground">Embedding Configuration</div>
                  <p className="text-xs text-muted-foreground">
                    Configure the embedding API endpoint for semantic memory search. All three fields are required for semantic recall to work.
                  </p>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Base URL</label>
                    <input
                      type="text"
                      className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-ring"
                      placeholder="https://api.openai.com/v1"
                      value={memorySettings.embedding?.baseUrl ?? ""}
                      onChange={(e) =>
                        updateMemorySettings({
                          embedding: { ...memorySettings.embedding, baseUrl: e.target.value }
                        })
                      }
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">API Key</label>
                    <input
                      type="password"
                      className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-ring"
                      placeholder="sk-..."
                      value={memorySettings.embedding?.apiKey ?? ""}
                      onChange={(e) =>
                        updateMemorySettings({
                          embedding: { ...memorySettings.embedding, apiKey: e.target.value }
                        })
                      }
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Model Name</label>
                    <input
                      type="text"
                      className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-ring"
                      placeholder="text-embedding-3-small"
                      value={memorySettings.embedding?.model ?? ""}
                      onChange={(e) =>
                        updateMemorySettings({
                          embedding: { ...memorySettings.embedding, model: e.target.value }
                        })
                      }
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">
                    Memory Tool Model
                  </label>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Dedicated model for memory operations (query rewriting, summarization). Leave empty to use the default tool model.
                  </p>
                  <input
                    type="text"
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-ring"
                    placeholder="Leave empty to use default tool model"
                    value={memorySettings.toolModel ?? ""}
                    onChange={(e) =>
                      updateMemorySettings({
                        toolModel: e.target.value.trim() || undefined
                      })
                    }
                  />
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* ── Section 2: Stats ── */}
        {stats ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <StatCard value={stats.count} label="Total Memories" />
              <StatCard value={stats.autoGenerated} label="Auto-generated" />
              <StatCard value={stats.manualAdded} label="Manually Added" />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border bg-card px-5 py-3">
              <div className="text-sm text-muted-foreground">
                Embeddings: <span className="font-medium text-foreground">{stats.embedding.ready}</span> ready, <span className="font-medium text-foreground">{stats.embedding.pending}</span> pending
              </div>
              {stats.embedding.ready < stats.count ? (
                <button
                  type="button"
                  className="rounded-lg border border-input px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                  onClick={async () => {
                    setActionError(null);
                    try {
                      await apiFetch("/api/v1/memories/reindex", { method: "POST", body: "{}" });
                    } catch (e) {
                      setActionError(toErrorMessage(e));
                    }
                  }}
                >
                  Reindex
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ── Section 3: Add Memory ── */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-base font-semibold text-foreground">Add Memory</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manually add a fact you want the agent to remember across conversations.
          </p>

          <textarea
            className="mt-4 min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-ring"
            placeholder="Enter what you want the AI to remember..."
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />

          <div className="mt-3 flex justify-end">
            <button
              type="button"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleCreate}
              disabled={newContent.trim().length === 0 || isCreating}
            >
              <span className="inline-flex items-center gap-1.5">
                {isCreating ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Plus size={14} />
                )}
                Add Memory
              </span>
            </button>
          </div>
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
              <h2 className="text-base font-semibold text-foreground">Memory List</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {activeSearchQuery
                  ? `Showing results for "${activeSearchQuery}".`
                  : `All stored memories.`}
              </p>
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
