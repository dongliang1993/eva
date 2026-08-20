import { createContext, useContext, type ReactNode } from "react";

/**
 * 当前会话工作区的名字 —— bash 命令行的主机标签用它(work-mi 这种)。
 *
 * 单独成 context 而不是沿 MessageBubble → ToolCallBlock 一路 prop drill:
 * MessageBubble 被 memo,任意 prop 变更都让它整树重渲染;context 的 value
 * 只在 workspace 切换时变,不触发普通消息重渲。和 subagents-context 同一思路。
 */
const WorkspaceNameContext = createContext<string | null>(null);

interface WorkspaceNameProviderProps {
  readonly name: string | null;
  readonly children: ReactNode;
}

export function WorkspaceNameProvider({ name, children }: WorkspaceNameProviderProps) {
  return <WorkspaceNameContext.Provider value={name}>{children}</WorkspaceNameContext.Provider>;
}

/** 取当前工作区名;未选择工作区时为 null(命令行就不显示主机标签)。 */
export function useWorkspaceName(): string | null {
  return useContext(WorkspaceNameContext);
}
