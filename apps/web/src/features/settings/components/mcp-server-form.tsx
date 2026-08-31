import { useState } from "react";
import { Plug } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../../shared/ui/select";
import type { McpServerInput } from "../../../types/api";

// ---------------------------------------------------------------------------
// 添加 server 表单 —— stdio / http 两套字段。
//
// 草稿只活在这里;提交成功(onAdd 返回 true)才清空,失败保留用户填的内容。
// ---------------------------------------------------------------------------

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

export function McpServerForm({
  busy,
  error,
  onAdd
}: {
  readonly busy: boolean;
  /** 上一次操作的错误文案(后端返回的中文,原样展示)。 */
  readonly error: string | null;
  /** 返回 true 表示已落库 —— 表单据此决定要不要清空。 */
  readonly onAdd: (body: McpServerInput) => Promise<boolean>;
}) {
  const [form, setForm] = useState(EMPTY_FORM);

  const handleAdd = async () => {
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

    if (await onAdd(body)) {
      setForm(EMPTY_FORM);
    }
  };

  return (
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
          <Select
            value={form.transport}
            onValueChange={(v) =>
              setForm((f) => ({ ...f, transport: v as McpServerInput["transport"] }))
            }
          >
            <SelectTrigger className="h-auto w-32 py-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">http</SelectItem>
            </SelectContent>
          </Select>
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
            onClick={() => void handleAdd()}
            disabled={busy || form.name.trim() === ""}
          >
            <Plug size={14} />
            添加并连接
          </button>
          {error ? <span className="text-sm text-red-500">{error}</span> : null}
        </div>
      </div>
    </section>
  );
}
