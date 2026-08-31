import { Check, X } from "lucide-react";

import type { MemoryCandidateRecord } from "../../../../types/api";

import { MetaChip } from "./memory-chips";

// ---------------------------------------------------------------------------
// 待审核记忆 —— autoSummarize 提取出的候选,确认后才进入跨会话检索。
//
// 刷新/接受/忽略都只是发 intent,请求与错误提示归 index.tsx。
// ---------------------------------------------------------------------------

type CandidateDecision = "accept" | "reject";

function MemoryCandidateCard({
  candidate,
  onDecide,
  disabled
}: {
  readonly candidate: MemoryCandidateRecord;
  readonly onDecide: (id: string, decision: CandidateDecision) => void;
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
          onClick={() => onDecide(candidate.id, "reject")}
        >
          <X size={13} /> 忽略
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          disabled={disabled}
          onClick={() => onDecide(candidate.id, "accept")}
        >
          <Check size={13} /> 保存
        </button>
      </div>
    </div>
  );
}

export function MemoryCandidateList({
  candidates,
  isDeciding,
  onRefresh,
  onDecide
}: {
  readonly candidates: readonly MemoryCandidateRecord[];
  readonly isDeciding: boolean;
  readonly onRefresh: () => void;
  readonly onDecide: (id: string, decision: CandidateDecision) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold text-foreground">待审核记忆</h2>
      <button
        type="button"
        className="mt-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={onRefresh}
      >
        刷新候选
      </button>
      <p className="mt-1 text-xs text-muted-foreground">
        这些事实来自已完成的对话；确认后才会进入跨会话检索。
      </p>
      <div className="mt-4 space-y-3">
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无待审核记忆。</p>
        ) : null}
        {candidates.map((candidate) => (
          <MemoryCandidateCard
            key={candidate.id}
            candidate={candidate}
            disabled={isDeciding}
            onDecide={onDecide}
          />
        ))}
      </div>
    </div>
  );
}
