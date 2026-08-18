import { useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, Plug, RefreshCw, Trash2 } from "lucide-react";

import { useMcpServers } from "../hooks/use-mcp-servers";
import type {
  McpConnectionState,
  McpServerConfig,
  McpServerInput,
  McpServerStatus
} from "../../../types/api";

const STATE_STYLE: Record<McpConnectionState, { readonly dot: string; readonly label: string }> = {
  connected: { dot: "bg-emerald-500", label: "已连接" },
  error: { dot: "bg-red-500", label: "连接失败" },
  disabled: { dot: "bg-muted-foreground/40", label: "已停用" }
};

const EMPTY_FORM = {
  name: "",
  transport: "stdio" as McpServerInput["transport"],
  command: "",
  args: "",
  env: "",
  url: "",
  headers: ""
};

/** "K=V" 每行一条 → Record。空行忽略；没有 = 的行整行当 key（值为空）。 */
const parseKeyValueLines = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const at = line.indexOf("=");
        return at < 0 ? [line, ""] : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      })
  );

function StatusDot({ state }: { readonly state: McpConnectionState }) {
  const style = STATE_STYLE[state];

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

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
            <StatusDot state={status?.state ?? "disabled"} />
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

export function McpSettings() {
  const mcp = useMcpServers();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const statusById = new Map(mcp.statuses.map((s) => [s.id, s]));

  /** 后端返回的 error 文案是给人看的中文，原样展示。 */
  const run = async (action: () => Promise<unknown>) => {
    setError(null);

    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleAdd = () =>
    run(async () => {
      const base = { name: form.name.trim(), autoApproveTools: [], enabled: true };
      const body: McpServerInput =
        form.transport === "stdio"
          ? {
            ...base,
            transport: "stdio",
            command: form.command.trim(),
            args: form.args.split("\n").map((a) => a.trim()).filter(Boolean),
            env: parseKeyValueLines(form.env)
          }
          : {
            ...base,
            transport: "http",
            url: form.url.trim(),
            headers: parseKeyValueLines(form.headers)
          };

      await mcp.addServerAsync(body);
      setForm(EMPTY_FORM);
    });

  if (mcp.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto">
      <section>
        <h2 className="mb-1 text-base font-semibold text-foreground">MCP Servers</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          接入 MCP server 就能给 agent 加一组工具，不用改代码。也可以把配置写进{" "}
          <code>~/.eva/mcp.json</code>（重启后同步，标记为 mcp.json 的条目只能在这里启停）。
          非只读工具默认需要审批。
        </p>

        {mcp.servers.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            还没有配置任何 MCP server。
          </p>
        ) : (
          <div className="space-y-2">
            {mcp.servers.map((server) => (
              <ServerRow
                key={server.id}
                server={server}
                status={statusById.get(server.id)}
                busy={mcp.isMutating}
                onToggle={(target) =>
                  run(() =>
                    mcp.updateServerAsync({
                      id: target.id,
                      body: { enabled: !target.enabled }
                    })
                  )
                }
                onReconnect={(id) => run(() => mcp.reconnectAsync(id))}
                onRemove={(target) => run(() => mcp.removeServerAsync(target.id))}
              />
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="mb-3 text-sm font-semibold text-foreground">添加 server</h3>

        <div className="grid gap-3">
          <div className="flex gap-3">
            <input
              className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              placeholder="名字（小写字母、数字、_、-）"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <select
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={form.transport}
              onChange={(e) =>
                setForm((f) => ({ ...f, transport: e.target.value as McpServerInput["transport"] }))
              }
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </div>

          {form.transport === "stdio" ? (
            <>
              <input
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                placeholder="命令，如 npx"
                value={form.command}
                onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
              />
              <textarea
                className="rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs"
                rows={3}
                placeholder={"参数，每行一个\n-y\n@modelcontextprotocol/server-filesystem\n/tmp"}
                value={form.args}
                onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
              />
              <textarea
                className="rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs"
                rows={2}
                placeholder={"环境变量，每行 KEY=VALUE（PATH 等会自动继承）"}
                value={form.env}
                onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
              />
            </>
          ) : (
            <>
              <input
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                placeholder="https://example.com/mcp"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              />
              <textarea
                className="rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs"
                rows={2}
                placeholder={"请求头，每行 KEY=VALUE\nAuthorization=Bearer xxx"}
                value={form.headers}
                onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
              />
            </>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
              onClick={handleAdd}
              disabled={mcp.isMutating || form.name.trim() === ""}
            >
              <Plug size={14} />
              添加并连接
            </button>
            {error ? <span className="text-sm text-red-500">{error}</span> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
