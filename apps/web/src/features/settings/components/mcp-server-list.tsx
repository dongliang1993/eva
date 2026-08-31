import { useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, RefreshCw, Trash2 } from "lucide-react";

import type { McpServerConfig, McpServerStatus } from "../../../types/api";

import { McpServerStateBadge } from "./mcp-server-state-badge";

// ---------------------------------------------------------------------------
// 已配置的 MCP server 列表 —— 每行一个 server,展开看它的工具。
//
// 启停 / 重连 / 删除都只是意图,请求与错误提示归 mcp-settings。
// ---------------------------------------------------------------------------

interface ServerRowProps {
  readonly server: McpServerConfig;
  readonly status: McpServerStatus | undefined;
  readonly onToggle: (server: McpServerConfig) => void;
  readonly onReconnect: (id: string) => void;
  readonly onRemove: (server: McpServerConfig) => void;
  readonly busy: boolean;
}

function ServerRow({ server, status, onToggle, onReconnect, onRemove, busy }: ServerRowProps) {
  const [expanded, setExpanded] = useState(false);
  const fromFile = server.origin === "file";
  const tools = status?.tools ?? [];

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((prev) => !prev)}
          title={expanded ? "收起" : "展开工具列表"}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
              {server.transport}
            </span>
            {fromFile ? (
              <span
                className="flex items-center gap-1 text-[10px] text-muted-foreground"
                title="配置来自 ~/.eva/mcp.json，只能在这里启停"
              >
                <FileCode2 size={11} />
                mcp.json
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-3">
            <McpServerStateBadge state={status?.state ?? "disabled"} />
            <span className="text-xs text-muted-foreground">{status?.toolCount ?? 0} 个工具</span>
          </div>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={server.enabled}
            disabled={busy}
            onChange={() => onToggle(server)}
          />
          启用
        </label>

        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          onClick={() => onReconnect(server.id)}
          disabled={busy || !server.enabled}
          title="重新连接"
        >
          <RefreshCw size={14} />
        </button>

        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-red-500 disabled:opacity-40"
          onClick={() => onRemove(server)}
          disabled={busy}
          title={fromFile ? "来自 mcp.json，请从文件中移除" : "删除"}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {status?.state === "error" && status.error ? (
        <p className="mt-2 rounded bg-red-500/10 px-2 py-1.5 font-mono text-xs text-red-500">
          {status.error}
        </p>
      ) : null}

      {expanded ? (
        <div className="mt-3 space-y-1 border-t border-border pt-3">
          {tools.length === 0 ? (
            <p className="text-xs text-muted-foreground">没有可用工具。</p>
          ) : (
            tools.map((tool) => (
              <div key={tool.name} className="flex items-start gap-2 text-xs">
                <code className="text-foreground">{tool.name}</code>
                <span className="text-muted-foreground/60">
                  {tool.autoApproved ? "免审批" : "需审批"}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {tool.description}
                </span>
              </div>
            ))
          )}
          {server.envKeys.length > 0 ? (
            <p className="pt-1 text-xs text-muted-foreground">
              env: {server.envKeys.join(", ")}（值不回传）
            </p>
          ) : null}
          {server.headerKeys.length > 0 ? (
            <p className="pt-1 text-xs text-muted-foreground">
              headers: {server.headerKeys.join(", ")}（值不回传）
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function McpServerList({
  servers,
  statuses,
  busy,
  onToggle,
  onReconnect,
  onRemove
}: {
  readonly servers: readonly McpServerConfig[];
  readonly statuses: readonly McpServerStatus[];
  readonly busy: boolean;
  readonly onToggle: (server: McpServerConfig) => void;
  readonly onReconnect: (id: string) => void;
  readonly onRemove: (server: McpServerConfig) => void;
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
          onReconnect={onReconnect}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
