import { useState } from "react";
import { Plus } from "lucide-react";

import { useMcpServers } from "../hooks/use-mcp-servers";
import type { McpServerConfig } from "../../../types/api";

import { McpServerDialog } from "./mcp-server-dialog";
import { McpServerList } from "./mcp-server-list";
import { McpToolsDialog } from "./mcp-tools-dialog";

// ---------------------------------------------------------------------------
// MCP 设置页 —— 只剩「发请求 + 收错误 + 两块版式」。
//
// 列表在 mcp-server-list(状态徽标在 mcp-server-state-badge),新建/编辑表单
// 在 mcp-server-dialog(Modal),工具详情在 mcp-tools-dialog(Modal);所有
// mutation 都从这里出去,错误文案也只有这一处(§7.19)。
// ---------------------------------------------------------------------------

/** 配置 Modal 的开关状态:新建(无参) / 编辑(带 server) / 关(null)。 */
type DialogState =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly server: McpServerConfig }
  | null;

export function McpSettings() {
  const mcp = useMcpServers();
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  /** 工具详情 Modal:开着时是对应 server 的 id,关是 null。 */
  const [toolsFor, setToolsFor] = useState<string | null>(null);

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
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            对所有项目生效，改动仅作用于新建会话。
          </p>
        </div>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          onClick={() => {
            setError(null);
            setDialog({ mode: "create" });
          }}
          disabled={mcp.isMutating}
        >
          <Plus size={14} />
          添加服务器
        </button>
      </div>

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
        onConfigure={(target) => {
          setError(null);
          setDialog({ mode: "edit", server: target });
        }}
        onShowTools={(target) => setToolsFor(target.id)}
      />

      {dialog ? (
        <McpServerDialog
          server={dialog.mode === "edit" ? dialog.server : undefined}
          busy={mcp.isMutating}
          error={error}
          onClose={() => setDialog(null)}
          onSave={async (body) => {
            const target = dialog.mode === "edit" ? dialog.server : undefined;

            const ok = await run(() =>
              target
                ? mcp.updateServerAsync({ id: target.id, body })
                : mcp.addServerAsync(body)
            );

            if (ok) {
              setDialog(null);
            }

            return ok;
          }}
          onDelete={async () => {
            if (dialog.mode !== "edit") {
              return false;
            }

            const ok = await run(() => mcp.removeServerAsync(dialog.server.id));

            if (ok) {
              setDialog(null);
            }

            return ok;
          }}
        />
      ) : null}

      {toolsFor ? (
        <McpToolsDialog
          server={mcp.servers.find((s) => s.id === toolsFor)!}
          tools={mcp.statuses.find((s) => s.id === toolsFor)?.tools ?? []}
          onClose={() => setToolsFor(null)}
        />
      ) : null}
    </div>
  );
}
