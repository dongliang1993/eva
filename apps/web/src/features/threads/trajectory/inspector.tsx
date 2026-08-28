import type { TrajectoryRow } from "./derive-trajectory";

/**
 * 类型化右侧检查器(T54):按行类型分面板。
 * Tool 的「调用当时 snapshot」由父组件 resolve 好传进来(request_snapshot_ref
 * 已在 snapshot.ts 顺过一遍)—— 显示的是历史那份,不是进程当前定义。
 */

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const formatMs = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      {children}
    </div>
  );
}

function KV({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-foreground/90">{value}</span>
    </div>
  );
}

function Pre({ value }: { readonly value: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-terminal/30 p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-foreground/90">
      {value}
    </pre>
  );
}

function HashLine({ label, hash }: { readonly label: string; readonly hash: unknown }) {
  if (typeof hash !== "string") return null;
  return <KV label={label} value={`${hash.slice(0, 12)}…`} />;
}

export function Inspector({
  row,
  snapshotPayload,
  onOpenSubRun,
  onClose
}: {
  readonly row: TrajectoryRow;
  readonly snapshotPayload?: unknown;
  readonly onOpenSubRun?: (runId: string) => void;
  readonly onClose: () => void;
}) {
  const payload = asRecord(row.payload);
  const snapshot = asRecord(snapshotPayload);

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">{row.kind}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          关闭
        </button>
      </div>
      <div className="truncate text-xs text-foreground/90" title={row.title}>
        {row.title}
      </div>

      {row.kind === "system" && payload ? (
        <>
          <Section title="Model / Settings">
            <KV label="provider" value={String(payload["provider"] ?? "?")} />
            <KV label="model" value={String(payload["modelId"] ?? "?")} />
            <KV label="settings" value={JSON.stringify(payload["callSettings"] ?? {})} />
          </Section>
          <Section title="System Prompt">
            <Pre value={String(payload["systemPrompt"] ?? "")} />
          </Section>
          <Section title="Tools">
            <Pre
              value={
                Array.isArray(payload["tools"])
                  ? payload["tools"]
                      .map((tool) => {
                        const t = asRecord(tool);
                        return `- ${String(t?.["name"] ?? "?")}: ${String(t?.["description"] ?? "")}`;
                      })
                      .join("\n")
                  : "(无)"
              }
            />
          </Section>
          <Section title="Part Hashes">
            {Object.entries(asRecord(payload["partHashes"]) ?? {}).map(([key, hash]) => (
              <HashLine key={key} label={key} hash={hash} />
            ))}
          </Section>
        </>
      ) : null}

      {row.kind === "assistant" && payload ? (
        <>
          <Section title="Text">
            <Pre value={String(payload["text"] ?? row.title)} />
          </Section>
          <Section title="Timing">
            {row.timing?.ttftMs !== undefined && <KV label="TTFT" value={formatMs(row.timing.ttftMs)} />}
            {row.durationMs !== null && <KV label="总时长" value={formatMs(row.durationMs)} />}
            {payload["toolCallCount"] !== undefined && (
              <KV label="工具调用" value={String(payload["toolCallCount"])} />
            )}
          </Section>
        </>
      ) : null}

      {row.kind === "tool" && payload ? (
        <>
          <Section title="Timing">
            <KV label="执行" value={formatMs(Number(payload["toolExecMs"] ?? 0))} />
            <KV label="审批等待" value={formatMs(Number(payload["approvalWaitMs"] ?? 0))} />
            <KV label="排队等待" value={formatMs(Number(payload["queueWaitMs"] ?? 0))} />
            {row.timing?.approvalAsked === true && (
              <KV
                label="审批"
                value={row.timing.approvalApproved === true ? "已允许" : "已拒绝"}
              />
            )}
            {payload["decomposed"] === false && <KV label="分解" value="否(abort 补发)" />}
            {payload["repaired"] !== undefined && <KV label="修复" value={String(payload["repaired"])} />}
          </Section>
          <Section title="Arguments">
            <Pre value={JSON.stringify(payload["args"] ?? {}, null, 2)} />
          </Section>
          {payload["output"] !== undefined && (
            <Section title="Result">
              <Pre value={String(payload["output"])} />
            </Section>
          )}
          {snapshot ? (
            <Section title="调用当时的 Snapshot">
              <KV label="provider" value={String(snapshot["provider"] ?? "?")} />
              <KV label="model" value={String(snapshot["modelId"] ?? "?")} />
              <Pre value={String(snapshot["systemPrompt"] ?? "").slice(0, 400)} />
            </Section>
          ) : (
            <div className="text-[11px] text-muted-foreground">
              调用当时的 snapshot 在未加载的页里(继续上滚加载后可见)。
            </div>
          )}
        </>
      ) : null}

      {row.kind === "subtool" && payload ? (
        <>
          <Section title="子代理">
            <KV label="类型" value={String(payload["subagentType"] ?? "?")} />
            <KV label="任务" value={String(payload["backgroundTaskId"] ?? "?")} />
            <KV label="状态" value={String(payload["status"] ?? "?")} />
            <KV label="事件数" value={String(payload["eventCount"] ?? 0)} />
          </Section>
          {onOpenSubRun && (
            <button
              type="button"
              onClick={() => onOpenSubRun(row.runId)}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent/50"
            >
              打开子 Run 轨迹 →
            </button>
          )}
        </>
      ) : null}

      {row.kind === "compacted" && payload ? (
        <Section title="Compact">
          <KV label="原因" value={String(payload["reason"] ?? "?")} />
          <KV label="tokens" value={`${String(payload["estimatedTokensBefore"] ?? "?")} → ${String(payload["estimatedTokensAfter"] ?? "?")}`} />
          <KV label="消息数" value={`${String(payload["messageCountBefore"] ?? "?")} → ${String(payload["messageCountAfter"] ?? "?")}`} />
        </Section>
      ) : null}

      {row.kind === "error" && payload ? (
        <Section title="Error">
          {payload["failureLayer"] !== undefined && (
            <KV label="failure_layer" value={String(payload["failureLayer"])} />
          )}
          <Pre value={String(payload["error"] ?? row.title)} />
        </Section>
      ) : null}

      {(row.kind === "user" || row.kind === "context" || row.kind === "raw") && payload ? (
        <Section title="Payload">
          <Pre value={JSON.stringify(payload, null, 2)} />
        </Section>
      ) : null}
    </aside>
  );
}
