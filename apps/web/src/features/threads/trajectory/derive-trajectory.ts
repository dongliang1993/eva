import type { RunEventDto, SubRunSummaryDto } from "@eva/shared";

/**
 * deriveTrajectory —— 纯投影(T53):吃 run_events 数组,输出展示行。
 *
 * 硬要求:纯函数、无副作用、展示行不落库(契约 1 —— 删掉能随时从 ledger 重算)。
 * 同一事件数组两次调用输出深相等;乱序输入排序后结果一致(组内按 seq,组间按首事件三元组)。
 *
 * 配对规则:
 * - model_call_started/first_token/completed + assistant_message → 一行 Assistant;
 * - tool_call_started + completed/abandoned → 一行 Tool;
 * - approval_asked/decided → Tool 行内的等待阶段,不单独占行;
 * - request_snapshot → System(也是 Request 边界);ref 不出行(检查器顺 ref 取正文);
 * - 后台子 Run 经 background_task_id → parent_tool_call_id 嵌到发起它的 Tool 行下;
 *   锚点还没翻到的子 Run 先不显示,不报错、不占位(设计文档 §9.1)。
 * - 未知 kind(未来版本)→ raw 行,投影不崩。
 */
export type TrajectoryRowKind =
  | "system"
  | "user"
  | "context"
  | "assistant"
  | "tool"
  | "subtool"
  | "compacted"
  | "error"
  | "raw";

export interface TrajectoryTiming {
  readonly ttftMs?: number;
  readonly execMs?: number;
  readonly approvalWaitMs?: number;
  readonly queueWaitMs?: number;
  readonly approvalAsked?: boolean;
  readonly approvalApproved?: boolean;
}

export interface TrajectoryRow {
  /** 稳定行 key —— prepend 旧页后不变,选中态与滚动位置靠它保持。 */
  readonly key: string;
  readonly kind: TrajectoryRowKind;
  readonly runId: string;
  /** 组成该行的首个事件在 Run 内的 seq(快照 ref 解析与检查器取上下文用;subtool 子行恒为 -1)。 */
  readonly seq: number;
  /** "main" | taskId(前台子代理)。 */
  readonly agent: string;
  readonly turnIndex: number | null;
  readonly stepIndex: number | null;
  readonly title: string;
  readonly status?: "success" | "error" | "aborted";
  readonly startedAtMs: number | null;
  readonly durationMs: number | null;
  readonly toolCallId?: string;
  /** 主要 payload(system prompt / tool args / 错误详情 …),检查器用。 */
  readonly payload?: unknown;
  readonly timing?: TrajectoryTiming;
  /** 嵌套的后台子 Run(subtool)。 */
  readonly children?: readonly TrajectoryRow[];
}

interface Payload {
  readonly [key: string]: unknown;
}

const asPayload = (value: unknown): Payload =>
  typeof value === "object" && value !== null ? (value as Payload) : {};

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const shortRunId = (runId: string): string => runId.slice(0, 8);

const truncate = (text: string, max = 80): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** 投影期的可变行(建成后以 TrajectoryRow 只读返回)。 */
type RowDraft = {
  -readonly [K in keyof TrajectoryRow]: TrajectoryRow[K];
};

/** 单 Run 投影:输入必须已是该 Run 的事件(任意顺序),内部按 seq 排。 */
const projectRun = (runId: string, events: readonly RunEventDto[]): RowDraft[] => {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const rows: RowDraft[] = [];
  const toolRowByCallId = new Map<string, RowDraft>();
  let currentAssistant: RowDraft | undefined;
  // finish 的 assistant_message 在 step_completed 之后才到 —— 它要落的是「该 Run 最近
  // 一行 Assistant」,与 step 边界无关,所以单独追踪,不随 closeAssistant 清掉。
  let lastAssistant: RowDraft | undefined;
  let currentTurn: number | null = null;
  let currentStep: number | null = null;

  const closeAssistant = (): void => {
    currentAssistant = undefined;
  };

  for (const event of ordered) {
    const payload = asPayload(event.payload);
    switch (event.kind) {
      case "run_started": {
        rows.push({
          key: `${runId}:user:${event.seq}`,
          kind: "user",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: null,
          stepIndex: null,
          title: `Run ${shortRunId(runId)}`,
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          payload: event.payload
        });
        break;
      }
      case "routing_resolved": {
        rows.push({
          key: `${runId}:routing:${event.seq}`,
          kind: "context",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: currentTurn,
          stepIndex: currentStep,
          title: `模型解析 ${str(payload["resolvedModel"]) ?? "?"}`,
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          payload: event.payload
        });
        break;
      }
      case "skills_selected": {
        const selected = Array.isArray(payload["selected"]) ? payload["selected"].join(", ") : "";
        rows.push({
          key: `${runId}:skills:${event.seq}`,
          kind: "context",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: currentTurn,
          stepIndex: currentStep,
          title: selected.length > 0 ? `选择技能 ${selected}` : "选择技能(无新增)",
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          payload: event.payload
        });
        break;
      }
      case "request_snapshot": {
        rows.push({
          key: `${runId}:system:${event.seq}`,
          kind: "system",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: currentTurn,
          stepIndex: currentStep,
          title: `请求快照 ${str(payload["modelId"]) ?? ""}`.trim(),
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          payload: event.payload
        });
        break;
      }
      case "request_snapshot_ref":
        // 引用不占行 —— 检查器顺 refSeq 取回正文(T54)。
        break;
      case "turn_started":
        currentTurn = event.turnIndex ?? currentTurn;
        currentStep = null;
        break;
      case "step_started":
        currentStep = event.stepIndex ?? currentStep;
        break;
      case "turn_completed":
        closeAssistant();
        currentTurn = event.turnIndex ?? currentTurn;
        break;
      case "step_completed":
        closeAssistant();
        currentStep = event.stepIndex ?? currentStep;
        break;
      case "model_call_started": {
        currentAssistant = {
          key: `${runId}:assistant:${event.seq}`,
          kind: "assistant",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: event.turnIndex ?? currentTurn,
          stepIndex: event.stepIndex ?? currentStep,
          title: "Assistant",
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          payload: event.payload
        };
        lastAssistant = currentAssistant;
        rows.push(currentAssistant);
        break;
      }
      case "model_first_token": {
        if (currentAssistant) {
          currentAssistant.timing = {
            ...currentAssistant.timing,
            ttftMs: event.durationMs ?? undefined
          };
        }
        break;
      }
      case "model_call_completed": {
        if (currentAssistant) {
          currentAssistant.durationMs =
            event.occurredAtMs - (currentAssistant.startedAtMs ?? event.occurredAtMs);
        }
        break;
      }
      case "assistant_message": {
        // finish 汇总:文本落到该 Run 最近一行 Assistant;没有就自己成行。
        const text = str(payload["text"]) ?? "";
        if (lastAssistant) {
          lastAssistant.title = truncate(text) || "Assistant";
          lastAssistant.payload = event.payload;
        } else {
          rows.push({
            key: `${runId}:assistant-msg:${event.seq}`,
            kind: "assistant",
            runId,
            seq: event.seq,
            agent: event.agent,
            turnIndex: event.turnIndex ?? currentTurn,
            stepIndex: event.stepIndex ?? currentStep,
            title: truncate(text) || "Assistant",
            startedAtMs: event.occurredAtMs,
            durationMs: null,
            payload: event.payload
          });
        }
        break;
      }
      case "tool_call_started": {
        const toolName = str(payload["toolName"]) ?? "tool";
        const row: RowDraft = {
          key: `${runId}:tool:${event.toolCallId ?? event.seq}`,
          kind: "tool",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: event.turnIndex ?? currentTurn,
          stepIndex: event.stepIndex ?? currentStep,
          title: toolName,
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          ...(event.toolCallId !== null ? { toolCallId: event.toolCallId } : {}),
          payload: event.payload
        };
        rows.push(row);
        if (event.toolCallId !== null) {
          toolRowByCallId.set(event.toolCallId, row);
        }
        break;
      }
      case "approval_asked": {
        const tool = event.toolCallId !== null ? toolRowByCallId.get(event.toolCallId) : undefined;
        if (tool) {
          tool.timing = { ...tool.timing, approvalAsked: true };
        }
        break;
      }
      case "approval_decided": {
        const tool = event.toolCallId !== null ? toolRowByCallId.get(event.toolCallId) : undefined;
        if (tool) {
          tool.timing = {
            ...tool.timing,
            approvalAsked: true,
            approvalApproved: payload["approved"] === true
          };
        }
        break;
      }
      case "tool_call_completed": {
        const tool = event.toolCallId !== null ? toolRowByCallId.get(event.toolCallId) : undefined;
        if (tool) {
          tool.status = payload["status"] === "error" ? "error" : "success";
          tool.durationMs = event.occurredAtMs - (tool.startedAtMs ?? event.occurredAtMs);
          tool.timing = {
            ...tool.timing,
            ...(num(payload["toolExecMs"]) !== undefined ? { execMs: num(payload["toolExecMs"]) } : {}),
            ...(num(payload["approvalWaitMs"]) !== undefined
              ? { approvalWaitMs: num(payload["approvalWaitMs"]) }
              : {}),
            ...(num(payload["queueWaitMs"]) !== undefined
              ? { queueWaitMs: num(payload["queueWaitMs"]) }
              : {})
          };
          // 完成的 payload 带 output,比 started 的 args-only 更有用 —— 合并而不是替换。
          tool.payload = { ...asPayload(tool.payload), ...payload };
        }
        break;
      }
      case "tool_call_abandoned": {
        const tool = event.toolCallId !== null ? toolRowByCallId.get(event.toolCallId) : undefined;
        if (tool) {
          tool.status = "aborted";
          tool.durationMs = event.durationMs ?? null;
          tool.payload = { ...asPayload(tool.payload), ...payload };
        }
        break;
      }
      case "tool_call_repaired": {
        // 标记到最近一行同名 Tool;找不到就降级 raw。
        const toolName = str(payload["toolName"]);
        const tool = [...toolRowByCallId.values()].reverse().find((row) => row.title === toolName);
        if (tool) {
          tool.payload = { ...asPayload(tool.payload), repaired: payload["repairKind"] };
        } else {
          rows.push({
            key: `${runId}:repaired:${event.seq}`,
            kind: "raw",
            runId,
            seq: event.seq,
            agent: event.agent,
            turnIndex: currentTurn,
            stepIndex: currentStep,
            title: `修复工具调用 ${toolName ?? "?"}`,
            startedAtMs: event.occurredAtMs,
            durationMs: null,
            payload: event.payload
          });
        }
        break;
      }
      case "context_compacted":
      case "context_overflow": {
        const before = num(payload["estimatedTokensBefore"]);
        const after = num(payload["estimatedTokensAfter"]);
        rows.push({
          key: `${runId}:compacted:${event.seq}`,
          kind: "compacted",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: event.turnIndex ?? currentTurn,
          stepIndex: event.stepIndex ?? currentStep,
          title:
            event.kind === "context_overflow"
              ? `上下文超限钳制(${str(payload["modelId"]) ?? "?"})`
              : before !== undefined && after !== undefined
                ? `上下文压缩 ${before} → ${after} tokens`
                : "上下文压缩",
          status: event.kind === "context_overflow" ? "error" : undefined,
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          payload: event.payload
        });
        break;
      }
      case "model_call_failed": {
        rows.push({
          key: `${runId}:model-failed:${event.seq}`,
          kind: "error",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: event.turnIndex ?? currentTurn,
          stepIndex: event.stepIndex ?? currentStep,
          title: truncate(str(payload["error"]) ?? "模型调用失败"),
          status: "error",
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          payload: event.payload
        });
        closeAssistant();
        break;
      }
      case "operation_abandoned": {
        rows.push({
          key: `${runId}:abandoned:${event.seq}`,
          kind: "error",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: event.turnIndex ?? currentTurn,
          stepIndex: event.stepIndex ?? currentStep,
          title: `操作未闭合:${str(payload["orphanKind"]) ?? "?"}`,
          status: "error",
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          payload: event.payload
        });
        break;
      }
      case "run_failed": {
        rows.push({
          key: `${runId}:run-failed:${event.seq}`,
          kind: "error",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: event.turnIndex ?? currentTurn,
          stepIndex: event.stepIndex ?? currentStep,
          title: truncate(str(payload["error"]) ?? "Run 失败"),
          status: "error",
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          payload: event.payload
        });
        break;
      }
      case "loop_transition": {
        if (payload["reason"] === "max_steps") {
          rows.push({
            key: `${runId}:max-steps:${event.seq}`,
            kind: "context",
            runId,
            seq: event.seq,
            agent: event.agent,
            turnIndex: event.turnIndex ?? currentTurn,
            stepIndex: event.stepIndex ?? currentStep,
            title: "达到最大步数",
            startedAtMs: event.occurredAtMs,
            durationMs: null,
            payload: event.payload
          });
        }
        // 其余 transition(reactive_compact/subagent_notice/max_output)由
        // compacted 行与 Assistant 行表达,不单独占行。
        break;
      }
      case "run_completed":
        closeAssistant();
        break;
      default: {
        // 未知 kind(未来版本):降级成一行 raw,投影不崩。
        rows.push({
          key: `${runId}:raw:${event.seq}`,
          kind: "raw",
          runId,
          seq: event.seq,
          agent: event.agent,
          turnIndex: event.turnIndex ?? currentTurn,
          stepIndex: event.stepIndex ?? currentStep,
          title: event.kind,
          startedAtMs: event.occurredAtMs,
          durationMs: null,
          payload: event.payload
        });
      }
    }
  }

  return rows;
};

/** 主投影入口。events 任意顺序;输出按首事件三元组 (occurredAtMs, runId, seq) 升序。 */
export const deriveTrajectory = (
  events: readonly RunEventDto[],
  subRuns: readonly SubRunSummaryDto[] = []
): TrajectoryRow[] => {
  const byRun = new Map<string, RunEventDto[]>();
  for (const event of events) {
    const bucket = byRun.get(event.runId);
    if (bucket) {
      bucket.push(event);
    } else {
      byRun.set(event.runId, [event]);
    }
  }

  const runs = [...byRun.entries()]
    .map(([runId, runEvents]): { runId: string; rows: RowDraft[]; first: RunEventDto } => {
      const rows = projectRun(runId, runEvents);
      const first = [...runEvents].sort(
        (a, b) =>
          a.occurredAtMs - b.occurredAtMs
          || a.runId.localeCompare(b.runId)
          || a.seq - b.seq
      )[0]!;
      return { runId, rows, first };
    })
    .sort(
      (a, b) =>
        a.first.occurredAtMs - b.first.occurredAtMs
        || a.first.runId.localeCompare(b.first.runId)
        || a.first.seq - b.first.seq
    );

  const rows = runs.flatMap((run) => run.rows);
  const toolRowByCallId = new Map<string, RowDraft>(
    rows
      .filter((row) => row.kind === "tool" && row.toolCallId !== undefined)
      .map((row) => [row.toolCallId!, row])
  );

  // 后台子 Run 嵌套:锚点(parent_tool_call_id 的 Tool 行)在才挂,不在就先不显示。
  for (const subRun of subRuns) {
    if (subRun.parentToolCallId === null) continue;
    const anchor = toolRowByCallId.get(subRun.parentToolCallId);
    if (anchor === undefined) continue;

    const child: TrajectoryRow = {
      key: `${anchor.key}:subtool:${subRun.runId}`,
      kind: "subtool",
      runId: subRun.runId,
      seq: -1,
      agent: subRun.backgroundTaskId ?? "subagent",
      turnIndex: null,
      stepIndex: null,
      title: `子代理 ${subRun.subagentType ?? "?"}`,
      status:
        subRun.status === "completed"
          ? "success"
          : subRun.status === "aborted"
            ? "aborted"
            : subRun.status === "error"
              ? "error"
              : undefined,
      startedAtMs: subRun.firstOccurredAtMs,
      durationMs:
        subRun.firstOccurredAtMs !== null && subRun.lastOccurredAtMs !== null
          ? subRun.lastOccurredAtMs - subRun.firstOccurredAtMs
          : null,
      payload: {
        subagentType: subRun.subagentType,
        backgroundTaskId: subRun.backgroundTaskId,
        eventCount: subRun.eventCount,
        status: subRun.status
      }
    };
    anchor.children = [...(anchor.children ?? []), child];
  }

  return rows;
};
