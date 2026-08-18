import type { SessionStatus } from "../../../types/api";

/**
 * 会话状态点:running = 蓝色 + 脉冲;requires_action = 橙色实心(它需要人操作,
 * 闪烁反而让人焦虑);idle = 不渲染。
 */
export function SessionStatusDot({ status }: { readonly status: SessionStatus }) {
  if (status === "idle") {
    return null;
  }

  if (status === "running") {
    return (
      <span
        title="正在运行"
        className="h-2 w-2 shrink-0 rounded-full bg-blue-500 animate-pulse"
      />
    );
  }

  return <span title="等待操作" className="h-2 w-2 shrink-0 rounded-full bg-orange-500" />;
}