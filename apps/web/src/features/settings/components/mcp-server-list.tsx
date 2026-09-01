import { Link2, Settings2 } from "lucide-react";

import type { McpServerConfig, McpServerStatus } from "../../../types/api";

import { McpServerStateBadge } from "./mcp-server-state-badge";
import { Toggle } from "./provider-toggle";

// ---------------------------------------------------------------------------
// 已配置的 MCP server 列表 —— 每行一张卡片。
//
// 行内只放:名称/状态/命令或 URL(左) + 工具数/设置/启停(右)。
// 所有动作都是意图,请求与错误提示归 mcp-settings;编辑表单与工具详情
// 各是一个 Modal(mcp-server-dialog / mcp-tools-dialog),开关由 mcp-settings 持有。
// ---------------------------------------------------------------------------

interface ServerRowProps {
  readonly server: McpServerConfig;
  readonly status: McpServerStatus | undefined;
  readonly busy: boolean;
  readonly onToggle: (server: McpServerConfig) => void;
  readonly onConfigure: (server: McpServerConfig) => void;
  readonly onShowTools: (server: McpServerConfig) => void;
}

function ServerRow({ server, status, busy, onToggle, onConfigure, onShowTools }: ServerRowProps) {
  // http 显示 URL,stdio 显示启动命令 —— 行副标题只放「连的是什么」这一条信息
  const subtitle = server.transport === "http" ? server.url : server.command;

  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <McpServerStateBadge state={status?.state ?? "disabled"} />
          <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
        </div>
        {subtitle ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>

      <button
        type="button"
        className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
        onClick={() => onShowTools(server)}
        title="查看连接的工具"
        disabled={busy}
      >
        <Link2 size={14} />
        {status?.toolCount ?? 0} tools
      </button>

      <button
        type="button"
        className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        onClick={() => onConfigure(server)}
        title="配置"
      >
        <Settings2 size={16} />
      </button>

      <Toggle checked={server.enabled} onChange={() => onToggle(server)} />
    </div>
  );
}

export function McpServerList({
  servers,
  statuses,
  busy,
  onToggle,
  onConfigure,
  onShowTools
}: {
  readonly servers: readonly McpServerConfig[];
  readonly statuses: readonly McpServerStatus[];
  readonly busy: boolean;
  readonly onToggle: (server: McpServerConfig) => void;
  readonly onConfigure: (server: McpServerConfig) => void;
  readonly onShowTools: (server: McpServerConfig) => void;
}) {
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  if (servers.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        还没有配置任何 MCP server。
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {servers.map((server) => (
        <ServerRow
          key={server.id}
          server={server}
          status={statusById.get(server.id)}
          busy={busy}
          onToggle={onToggle}
          onConfigure={onConfigure}
          onShowTools={onShowTools}
        />
      ))}
    </div>
  );
}
