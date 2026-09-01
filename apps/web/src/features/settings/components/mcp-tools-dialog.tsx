import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle
} from "../../../shared/ui/dialog";
import type { McpServerConfig, McpToolSummary } from "../../../types/api";

// ---------------------------------------------------------------------------
// 工具详情 Dialog —— 点列表行的「N tools」打开。
//
// 左栏:搜索框 + 工具列表(名称 + 参数数);右栏:选中工具的描述与参数表。
// 数据全部来自 GET /api/v1/mcp-servers 的 tools 摘要(params 在 server 侧
// 从 inputSchema 派生),这里零请求、纯展示。开关与遮罩/Esc 关闭在
// shared/ui/dialog(radix 封装)里。
// ---------------------------------------------------------------------------

const inputClass =
  "h-9 w-full rounded-lg border border-input bg-background pl-8 pr-3 text-sm text-foreground " +
  "placeholder:text-muted-foreground/60 outline-none focus:border-ring transition-colors";

export function McpToolsDialog({
  server,
  tools,
  onClose
}: {
  readonly server: McpServerConfig;
  readonly tools: readonly McpToolSummary[];
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(tools[0]?.name ?? null);

  // 版本偏斜容忍:老 server 的 tools 不带 params —— 缺席按空参数表渲染。
  // 没有这层的话,一个 undefined.length 会把整页炸掉(应用没有 error boundary)。
  const normalized = useMemo(
    () => tools.map((tool) => ({ ...tool, params: tool.params ?? [] })),
    [tools]
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();

    if (keyword.length === 0) {
      return normalized;
    }

    return normalized.filter((tool) => tool.name.toLowerCase().includes(keyword));
  }, [normalized, query]);

  const current =
    filtered.find((tool) => tool.name === selected) ?? filtered[0] ?? null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="h-[560px] w-[760px] max-w-[90vw]"
        aria-describedby={undefined}
      >
        <div className="px-5 py-4">
          <DialogTitle>{server.name} 提供的工具</DialogTitle>
        </div>

        <div className="flex min-h-0 flex-1 gap-0 border-t border-border">
          {/* 左栏:搜索 + 工具列表 */}
          <div className="flex w-64 shrink-0 flex-col border-r border-border">
            <div className="p-3">
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60"
                />
                <input
                  className={inputClass}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索 tool"
                  autoFocus
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {filtered.length === 0 ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">没有匹配的工具。</p>
              ) : (
                filtered.map((tool) => {
                  const active = current?.name === tool.name;

                  return (
                    <button
                      key={tool.name}
                      type="button"
                      className={`flex w-full items-baseline justify-between gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                        active
                          ? "bg-accent text-foreground"
                          : "text-foreground hover:bg-accent/60"
                      }`}
                      onClick={() => setSelected(tool.name)}
                    >
                      <span className="truncate text-[13px] font-medium">{tool.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {tool.params.length} params
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* 右栏:选中工具的描述 + 参数表 */}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {current ? (
              <>
                <h3 className="font-mono text-sm font-semibold text-foreground">
                  {current.name}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">{current.description}</p>

                <h4 className="mb-2 mt-5 text-sm font-medium text-foreground">参数</h4>

                {current.params.length === 0 ? (
                  <p className="text-xs text-muted-foreground">该工具没有参数。</p>
                ) : (
                  <div className="space-y-3">
                    {current.params.map((param) => (
                      <div key={param.name} className="text-sm">
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-[13px] font-medium text-foreground">
                            {param.name}
                          </code>
                          <span className="text-xs text-muted-foreground">{param.type}</span>
                          {param.required ? (
                            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                              required
                            </span>
                          ) : null}
                        </div>
                        {param.description ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {param.description}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">该 server 没有可用工具。</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
