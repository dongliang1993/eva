import { useState } from "react";
import { Check, FileText, Pencil, X, XCircle } from "lucide-react";

import type { PlanReviewDecision } from "@eva/shared";

import type { PendingPlanReview, PlanReviewClientOutcome } from "../api";

interface PlanReviewCardProps {
  readonly review: PendingPlanReview;
  readonly resolved?: PlanReviewDecision;
  readonly onDecide: (
    callId: string,
    outcome: PlanReviewClientOutcome,
    payload?: { feedback?: string; selectedLabel?: string }
  ) => void;
}

const outcomeLabel = (decision: PlanReviewDecision): string => {
  switch (decision.outcome) {
    case "approve":
      return decision.selectedLabel ? `已批准 · ${decision.selectedLabel}` : "已批准";
    case "revise":
      return "已要求修订";
    case "reject":
      return "已拒绝";
    case "reject_and_exit":
      return "已拒绝并退出";
    case "dismissed":
      return "已撤下";
  }
};

export function PlanReviewCard({ review, resolved, onDecide }: PlanReviewCardProps) {
  const [mode, setMode] = useState<"none" | "revise" | "reject">("none");
  const [feedback, setFeedback] = useState("");

  const decidedLabel = resolved
    ? `${outcomeLabel(resolved)} · ${new Date(resolved.decidedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })}`
    : null;

  const submitFeedback = (outcome: PlanReviewClientOutcome) => {
    onDecide(review.callId, outcome, feedback.trim() ? { feedback } : {});
    setMode("none");
    setFeedback("");
  };

  return (
    <div className="my-3 max-w-[70%] rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-start gap-2">
        <FileText size={18} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">
            Plan review <span className="text-xs font-normal text-muted-foreground">v{review.revision}</span>
          </div>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-xs text-muted-foreground">
            {review.planMarkdown}
          </pre>

          {decidedLabel ? (
            <span
              className={`mt-2 inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${
                resolved?.outcome === "approve"
                  ? "bg-primary/10 text-primary"
                  : resolved?.outcome === "dismissed"
                    ? "bg-muted text-muted-foreground"
                    : "bg-destructive/10 text-destructive"
              }`}
            >
              {decidedLabel}
            </span>
          ) : (
            <div className="mt-2 space-y-2">
              {review.options && review.options.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {review.options.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      title={option.description}
                      className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
                      onClick={() =>
                        onDecide(review.callId, "approve", { selectedLabel: option.label })
                      }
                    >
                      <Check size={12} />
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                {!review.options || review.options.length === 0 ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
                    onClick={() => onDecide(review.callId, "approve")}
                  >
                    <Check size={12} />
                    批准
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
                  onClick={() => setMode(mode === "revise" ? "none" : "revise")}
                >
                  <Pencil size={12} />
                  修订
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
                  onClick={() => setMode(mode === "reject" ? "none" : "reject")}
                >
                  <X size={12} />
                  拒绝
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded bg-destructive/90 px-2.5 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive"
                  onClick={() => onDecide(review.callId, "reject_and_exit")}
                >
                  <XCircle size={12} />
                  拒绝并退出
                </button>
              </div>

              {mode !== "none" ? (
                <div className="space-y-2">
                  <textarea
                    value={feedback}
                    onChange={(event) => setFeedback(event.target.value)}
                    placeholder={mode === "revise" ? "修订意见（必填）" : "拒绝原因（可选）"}
                    className="min-h-[72px] w-full rounded border border-border bg-background p-2 text-xs text-foreground outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    disabled={mode === "revise" && feedback.trim().length === 0}
                    className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    onClick={() => submitFeedback(mode === "revise" ? "revise" : "reject")}
                  >
                    <Check size={12} />
                    提交{mode === "revise" ? "修订" : "拒绝"}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
