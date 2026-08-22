import { ShieldAlert, ShieldCheck, Check, X, Sparkles } from "lucide-react";

import type { ApprovalDecision, ToolRiskLevel } from "@eva/shared";
import type { PendingApproval } from "../api";

interface ApprovalCardProps {
  readonly approval: PendingApproval;
  readonly onDecide: (callId: string, allowed: boolean) => void;
  readonly onAllowAlways: (callId: string) => void;
  /** T30:已决策的定格态 —— 有值时渲染「已允许/已拒绝 · 时间」,隐藏按钮。 */
  readonly resolved?: ApprovalDecision;
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

/** destructive → 红底 + ShieldAlert;elevated → 现有 warning 黄 + ShieldAlert;normal → 中性。 */
const levelStylize = (
  level: ToolRiskLevel
): { border: string; bg: string; icon: typeof ShieldAlert; iconClass: string } => {
  if (level === "destructive") {
    return {
      border: "border-destructive/60",
      bg: "bg-destructive/5",
      icon: ShieldAlert,
      iconClass: "text-destructive"
    };
  }
  // elevated 沿用现有 warning 黄(normal 基本不会出现 —— 危险工具至少 elevated)。
  return {
    border: "border-warning/40",
    bg: "bg-warning/5",
    icon: ShieldAlert,
    iconClass: "text-warning"
  };
};

export function ApprovalCard({
  approval,
  onDecide,
  onAllowAlways,
  resolved
}: ApprovalCardProps) {
  const { level, reasons } = approval.risk;
  const style = levelStylize(level);
  const RiskIcon = style.icon;
  const destructive = level === "destructive";

  // T30 定格态:决策时间 HH:MM(decidedAt 与 approval_requests.decidedAt 同源)。
  const decidedLabel = resolved
    ? `${resolved.action === "granted" ? "已允许" : "已拒绝"} · ${
      new Date(resolved.decidedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    }`
    : null;

  return (
    <div className={`my-3 max-w-[60%] rounded-md border p-3 ${style.border} ${style.bg}`}>
      <div className="flex items-start gap-2">
        <RiskIcon size={18} className={`mt-0.5 shrink-0 ${style.iconClass}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              Approve {approval.tool}
              {destructive ? (
                <span className="ml-2 rounded bg-destructive px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-destructive-foreground">
                  高风险
                </span>
              ) : null}
            </span>
          </div>

          {/* 命中的风险原因,一行为一个标签。 */}
          {reasons.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {reasons.map((reason) => (
                <span
                  key={reason}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                    destructive
                      ? "bg-destructive/10 text-destructive"
                      : "bg-warning/15 text-warning-foreground"
                  }`}
                >
                  {destructive ? <ShieldCheck size={10} /> : <ShieldAlert size={10} />}
                  {reason}
                </span>
              ))}
            </div>
          ) : null}

          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
            {summarizeArgs(approval.args, approval.tool)}
          </pre>

          <div className="mt-2 flex items-center gap-2">
            {decidedLabel ? (
              // T30:决策后定格 —— 隐藏三个按钮,只留结论 + 时间。
              <span
                className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${
                  resolved?.action === "granted"
                    ? "bg-primary/10 text-primary"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {resolved?.action === "granted" ? <Check size={12} /> : <X size={12} />}
                {decidedLabel}
              </span>
            ) : (
              <>
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
                {/* destructive 不给「始终允许」:能 rm -rf 的工具不该有"以后别问了"。 */}
                {!destructive ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
                    onClick={() => onAllowAlways(approval.callId)}
                  >
                    <Sparkles size={12} />
                    始终允许 {approval.tool}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}