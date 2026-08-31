import { useState } from "react";

import { useMcpServers } from "../hooks/use-mcp-servers";
import type { McpServerInput } from "../../../types/api";

import { McpServerForm } from "./mcp-server-form";
import { McpServerList } from "./mcp-server-list";

// ---------------------------------------------------------------------------
// MCP 设置页 —— 只剩「发请求 + 收错误 + 两块版式」。
//
// 列表在 mcp-server-list(状态徽标在 mcp-server-state-badge),表单在
// mcp-server-form;所有 mutation 都从这里出去,错误文案也只有这一处(§7.19)。
// ---------------------------------------------------------------------------

export function McpSettings() {
  const mcp = useMcpServers();
  const [error, setError] = useState<string | null>(null);

  /** 后端返回的 error 文案是给人看的中文,原样展示。 */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setError(null);

    try {
      await action();

      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));

      return false;
    }
  };

  if (mcp.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto">
      <section>
        <h2 className="mb-1 text-base font-semibold text-foreground">MCP 服务器</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          管理模型上下文协议 (MCP) 服务器以扩展 AI 能力
        </p>

        <McpServerList
          servers={mcp.servers}
          statuses={mcp.statuses}
          busy={mcp.isMutating}
          onToggle={(target) => {
            void run(() =>
              mcp.updateServerAsync({
                id: target.id,
                body: { enabled: !target.enabled }
              })
            );
          }}
          onReconnect={(id) => {
            void run(() => mcp.reconnectAsync(id));
          }}
          onRemove={(target) => {
            void run(() => mcp.removeServerAsync(target.id));
          }}
        />
      </section>

      <McpServerForm
        busy={mcp.isMutating}
        error={error}
        onAdd={(body: McpServerInput) => run(() => mcp.addServerAsync(body))}
      />
    </div>
  );
}
