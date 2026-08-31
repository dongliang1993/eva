import { Loader2, Plus } from "lucide-react";

/** 手动添加记忆 —— 受控 textarea,提交与错误处理归 index.tsx。 */
export function MemoryEditor({
  content,
  onContentChange,
  onSubmit,
  isCreating
}: {
  readonly content: string;
  readonly onContentChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly isCreating: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold text-foreground">添加记忆</h2>

      <textarea
        className="mt-4 min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-ring"
        placeholder="输入想让 AI 记住的内容..."
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
      />

      <button
        type="button"
        className="mt-3 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        onClick={onSubmit}
        disabled={content.trim().length === 0 || isCreating}
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
  );
}
