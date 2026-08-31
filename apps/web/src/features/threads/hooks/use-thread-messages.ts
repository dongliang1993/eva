import { useCallback } from "react";

import {
  fetchThreadMessages,
  fetchThreadStatus,
  switchVersion as switchVersionApi
} from "../api";
import type { ChatProjectionAction } from "../stream-reducer";

/**
 * 历史侧 —— 只做「从服务端读，投影整体替换」这一件事(§7.18)。
 *
 * 这一层碰不到在飞的 run:它派出去的 action 只改 committed / siblingIdsById,
 * streaming 那条通道归 use-run-controller。
 */
export interface UseThreadMessagesResult {
  /** 从服务端对齐一轮激活链(load / run 结束回灌 / 409 回滚都走它)。 */
  readonly syncFromServer: (threadId: string) => void;
  /** 切到某条消息所在分支的叶子(前端只在同槽位版本间调)。 */
  readonly switchVersion: (messageId: string) => void;
  /** 发现这个会话有没有一轮还在服务端跑;拉不到就当没有(退回只读历史)。 */
  readonly fetchActiveRunId: (threadId: string) => Promise<string | null>;
}

export function useThreadMessages(
  dispatch: (action: ChatProjectionAction) => void
): UseThreadMessagesResult {
  const syncFromServer = useCallback((threadId: string): void => {
    fetchThreadMessages(threadId)
      .then((rows) => {
        dispatch({ type: "thread/loaded", rows });
      })
      .catch(() => {
        // 拉取失败保留本地;用户切会话重试即可。
      });
  }, [dispatch]);

  const switchVersion = useCallback((messageId: string): void => {
    switchVersionApi(messageId)
      .then((rows) => {
        dispatch({ type: "thread/loaded", rows });
      })
      .catch(() => {
        // 切换失败保留当前分支。
      });
  }, [dispatch]);

  const fetchActiveRunId = useCallback((threadId: string): Promise<string | null> =>
    fetchThreadStatus(threadId)
      .then((status) => status.activeRunId)
      .catch(() => null), []);

  return { syncFromServer, switchVersion, fetchActiveRunId };
}
