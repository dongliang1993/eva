import { ShieldAlert, Check, X, Sparkles } from "lucide-react";

import type { PendingApproval } from "../api/approvals";

interface ApprovalCardProps {
  readonly approval: PendingApproval;
  readonly onDecide: (callId: string, allowed: boolean) => void;
  readonly onAllowAlways: (callId: string) => void;
}

const summarizeArgs = (args: Record<string, unknown>, tool: string): string => {
  // bash 展示命令, write/edit 展示路径, 其它给 JSON 摘要。
  switch (tool) {
    case "bash":
      return String(args.command ?? "");
    case "write":
    case "edit":
      return String(args.path ?? "");
    default:
      return JSON.stringify(args, null, 2).slice(0, 200);
  }
};

export function ApprovalCard({
  approval,
  onDecide,
  onAllowAlways
}: ApprovalCardProps) {
  return (
    <div className="my-3 max-w-[60%] rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              Approve {approval.tool}
            </span>
          </div>
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
            {summarizeArgs(approval.args, approval.tool)}
          </pre>

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded bg-destructive/90 px-2.5 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive"
              onClick={() => onDecide(approval.callId, false)}
            >
              <X size={12} />
              拒绝
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
              onClick={() => onDecide(approval.callId, true)}
            >
              <Check size={12} />
              允许一次
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
              onClick={() => onAllowAlways(approval.callId)}
            >
              <Sparkles size={12} />
              始终允许
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}