import { useRef, useState, type ClipboardEvent } from "react";
import { Plus, Trash2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle
} from "../../../shared/ui/dialog";
import type { McpServerConfig, McpServerInput, McpTransport } from "../../../types/api";

// ---------------------------------------------------------------------------
// MCP 配置 Modal —— 新建与编辑共用同一个表单。
//
// 配置的事实源是 ~/.eva/mcp.json,env / headers 的值随配置回传(文件本身是
// 明文,UI 在本机信任域)—— 编辑态直接回显已存的值,保存即全量写回。
// 开关与遮罩/Esc 关闭在 shared/ui/dialog(radix 封装)里。
// ---------------------------------------------------------------------------

/** 行带稳定 id:删中间行时 index 作 key 会让输入框错位串值。 */
interface Row {
  readonly id: number;
  readonly value: string;
}

interface PairRow {
  readonly id: number;
  readonly key: string;
  readonly value: string;
}

const rowsFromValues = (values: readonly string[]): Row[] =>
  (values.length > 0 ? values : [""]).map((value, id) => ({ id, value }));

const pairsFromRecord = (record: Readonly<Record<string, string>>): PairRow[] => {
  const entries = Object.entries(record);

  return (entries.length > 0 ? entries : [["", ""]]).map(([key, value], id) => ({
    id,
    key,
    value
  }));
};

const inputClass =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground " +
  "placeholder:text-muted-foreground/60 outline-none focus:border-ring transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const TRANSPORT_OPTIONS: readonly { readonly value: McpTransport; readonly label: string }[] = [
  { value: "http", label: "流式 HTTP" },
  { value: "stdio", label: "STDIO" }
];

export function McpServerDialog({
  server,
  busy,
  error,
  onClose,
  onSave,
  onDelete
}: {
  /** 有 = 编辑态;无 = 新建。 */
  readonly server?: McpServerConfig;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  /** 返回 true = 已落库(调用方负责关 Modal)。 */
  readonly onSave: (body: McpServerInput) => Promise<boolean>;
  readonly onDelete: () => Promise<boolean>;
}) {
  const editing = server !== undefined;

  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [args, setArgs] = useState<Row[]>(() => rowsFromValues(server?.args ?? []));
  const [env, setEnv] = useState<PairRow[]>(() => pairsFromRecord(server?.env ?? {}));
  const [headers, setHeaders] = useState<PairRow[]>(() => pairsFromRecord(server?.headers ?? {}));

  const nextRowId = useRef(-1);
  const newRowId = (): number => {
    nextRowId.current -= 1;
    return nextRowId.current;
  };

  /** 参数输入框整段粘贴:按换行拆成多行(占位提示「粘贴会自动拆分」的兑现)。 */
  const handleArgsPaste = (index: number, event: ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData("text");

    if (!text.includes("\n")) {
      return;
    }

    event.preventDefault();
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    setArgs((prev) => [
      ...prev.slice(0, index),
      ...lines.map((value) => ({ id: newRowId(), value })),
      ...prev.slice(index + 1)
    ]);
  };

  const pairsToRecord = (rows: readonly PairRow[]): Record<string, string> =>
    Object.fromEntries(
      rows
        .filter((row) => row.key.trim().length > 0)
        .map((row) => [row.key.trim(), row.value.trim()])
    );

  const canSave =
    !busy &&
    name.trim().length > 0 &&
    (transport === "stdio" ? command.trim().length > 0 : url.trim().length > 0);

  const handleSave = async (): Promise<void> => {
    if (!canSave) {
      return;
    }

    const base = {
      name: name.trim(),
      transport,
      // 编辑态不改这两项 —— 表单里没有对应控件,原样带回。
      autoApproveTools: server?.autoApproveTools ?? [],
      enabled: server?.enabled ?? true
    };

    const body: McpServerInput =
      transport === "stdio"
        ? {
          ...base,
          command: command.trim(),
          args: args.map((row) => row.value.trim()).filter(Boolean),
          env: pairsToRecord(env)
        }
        : {
          ...base,
          url: url.trim(),
          headers: pairsToRecord(headers)
        };

    await onSave(body);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[560px]" aria-describedby={undefined}>
        <div className="px-5 py-4">
          <DialogTitle>MCP 配置</DialogTitle>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          <div className="grid grid-cols-[80px_1fr] items-start gap-x-4 gap-y-5">
            <label className="pt-2 text-sm text-muted-foreground">名称</label>
            <input
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="小写字母、数字、下划线和连字符"
            />

            <label className="pt-2 text-sm text-muted-foreground">类型</label>
            <div className="flex rounded-lg bg-muted p-1" role="tablist">
              {TRANSPORT_OPTIONS.map((option) => {
                const active = transport === option.value;

                return (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? "border border-border bg-card font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => setTransport(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            {transport === "stdio" ? (
              <>
                <label className="pt-2 text-sm text-muted-foreground">启动命令</label>
                <input
                  className={inputClass}
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="如 npx"
                />

                <div className="flex flex-col gap-0.5 pt-2">
                  <span className="text-sm text-muted-foreground">参数</span>
                  <span className="text-[11px] text-muted-foreground/70">每行一个，粘贴会自动拆分</span>
                </div>
                <div className="flex flex-col gap-2">
                  {args.map((row, index) => (
                    <div key={row.id} className="flex items-center gap-2">
                      <input
                        className={inputClass}
                        value={row.value}
                        onChange={(event) =>
                          setArgs((prev) =>
                            prev.map((r, i) => (i === index ? { ...r, value: event.target.value } : r))
                          )
                        }
                        onPaste={(event) => handleArgsPaste(index, event)}
                      />
                      <button
                        type="button"
                        className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-40"
                        onClick={() => setArgs((prev) => prev.filter((_, i) => i !== index))}
                        title="删除该参数"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                    onClick={() => setArgs((prev) => [...prev, { id: newRowId(), value: "" }])}
                  >
                    <Plus size={13} />
                    添加参数
                  </button>
                </div>

                <EnvPairFields
                  label="环境变量"
                  rows={env}
                  onChange={setEnv}
                />
              </>
            ) : (
              <>
                <label className="pt-2 text-sm text-muted-foreground">URL</label>
                <input
                  className={inputClass}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                />

                <EnvPairFields
                  label="请求头"
                  rows={headers}
                  onChange={setHeaders}
                />
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4">
          {editing ? (
            <button
              type="button"
              className="text-sm text-destructive hover:underline disabled:opacity-40"
              onClick={() => void onDelete()}
              disabled={busy}
            >
              删除
            </button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-3">
            {error ? (
              <span className="max-w-56 truncate text-xs text-destructive" title={error}>
                {error}
              </span>
            ) : null}
            <button
              type="button"
              className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground hover:bg-accent"
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void handleSave()}
              disabled={!canSave}
            >
              保存
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** env / headers 的 K=V 行编辑。值随配置回传 —— 编辑态直接回显已存的值。 */
function EnvPairFields({
  label,
  rows,
  onChange
}: {
  readonly label: string;
  readonly rows: readonly PairRow[];
  readonly onChange: (rows: PairRow[]) => void;
}) {
  const nextRowId = useRef(-1);
  const addRow = () => {
    nextRowId.current -= 1;
    onChange([...rows, { id: nextRowId.current, key: "", value: "" }]);
  };

  return (
    <>
      <label className="pt-2 text-sm text-muted-foreground">{label}</label>
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div key={row.id} className="flex items-center gap-2">
            <input
              className={inputClass}
              value={row.key}
              onChange={(event) =>
                onChange(rows.map((r, i) => (i === index ? { ...r, key: event.target.value } : r)))
              }
              placeholder="KEY"
            />
            <input
              className={inputClass}
              value={row.value}
              onChange={(event) =>
                onChange(rows.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)))
              }
              placeholder="VALUE"
            />
            <button
              type="button"
              className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-40"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              title="删除该条"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          onClick={addRow}
        >
          <Plus size={13} />
          添加{label}
        </button>
      </div>
    </>
  );
}
