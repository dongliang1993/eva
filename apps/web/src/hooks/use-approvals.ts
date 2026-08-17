import { useCallback, useEffect, useRef, useState } from "react";

import { decideApproval, listApprovals, type PendingApproval } from "../api/approvals";

const POLL_MS = 900;

/**
 * 轮询待审批的危险工具请求(main loop 里工具执行前挂起, 前端轮询发现并展示)。
 * 三选: 允许一次 / 拒绝 / 始终允许(始终允许额外设 autoApprove)。
 * @param alwaysAllowEnabled 外部提供「始终允许」开关能力 —— 由调用方置位后发起。
 */
export function useApprovals(alwaysAllowEnabled?: () => Promise<void> | void) {
  const [pending, setPending] = useState<readonly PendingApproval[]>([]);
  const alwaysRef = useRef(alwaysAllowEnabled);
  alwaysRef.current = alwaysAllowEnabled;

  const refresh = useCallback(async () => {
    try {
      const items = await listApprovals();
      setPending(items);
    } catch {
      // 轮询失败静默,下次重试
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const decide = useCallback(async (callId: string, allowed: boolean) => {
    await decideApproval(callId, allowed);
    setPending((prev) => prev.filter((p) => p.callId !== callId));
  }, []);

  /** 允许执行,并把「始终允许」落到 autoApprove。 */
  const allowAlways = useCallback(async (callId: string) => {
    await alwaysRef.current?.();
    await decide(callId, true);
  }, [decide]);

  return { pending, decide, allowAlways };
}