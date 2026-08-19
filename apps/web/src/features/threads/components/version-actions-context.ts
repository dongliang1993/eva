import { createContext, useContext } from "react";

import type { SiblingIdsById } from "../hooks/use-chat";

export interface VersionActions {
  /** id → 同槽位全部版本 id(激活链上该消息的版本兄弟)。 */
  readonly siblingIdsById: SiblingIdsById;
  /** 是否正在流式(重新生成按钮在流式中禁用)。 */
  readonly isStreaming: boolean;
  readonly onRegenerate: (messageId: string) => void;
  readonly onSwitchVersion: (messageId: string) => void;
}

const VersionActionsContext = createContext<VersionActions | null>(null);

export const VersionActionsProvider = VersionActionsContext.Provider;

export const useVersionActions = (): VersionActions => {
  const ctx = useContext(VersionActionsContext);
  if (!ctx) {
    throw new Error("useVersionActions must be used within VersionActionsProvider");
  }
  return ctx;
};