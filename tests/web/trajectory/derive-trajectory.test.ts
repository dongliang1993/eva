import { describe, expect, it } from "vitest";

import type { RunEventDto, SubRunSummaryDto } from "@eva/shared";
import { deriveTrajectory } from "../../../apps/web/src/features/threads/trajectory/derive-trajectory.js";

let seq = 0;
const ev = (
  runId: string,
  kind: string,
  overrides: Partial<RunEventDto> = {}
): RunEventDto => ({
  id: `${runId}-${seq}`,
  runId,
  sessionId: "s-1",
  seq: seq++,
  agent: "main",
  kind,
  turnIndex: null,
  stepIndex: null,
  attempt: null,
  toolCallId: null,
  parentToolCallId: null,
  severity: "info",
  payload: {},
  occurredAtMs: 1000 + seq,
  durationMs: null,
  ...overrides
});

/** 一条含并行工具调用 + 审批 + 前台子代理的完整事件序列。 */
const buildEvents = (): RunEventDto[] => {
  seq = 0;
  return [
    ev("r-1", "run_started", { payload: { requestedModel: "openai:test" } }),
    ev("r-1", "routing_resolved", { payload: { resolvedModel: "openai:test" } }),
    ev("r-1", "turn_started", { turnIndex: 0 }),
    ev("r-1", "request_snapshot", { payload: { modelId: "test", systemPrompt: "sys" } }),
    ev("r-1", "step_started", { stepIndex: 0, attempt: 1 }),
    ev("r-1", "model_call_started", { stepIndex: 0, attempt: 1 }),
    ev("r-1", "model_first_token", { stepIndex: 0, attempt: 1, durationMs: 320 }),
    ev("r-1", "tool_call_started", {
      stepIndex: 0,
      toolCallId: "call-1",
      payload: { toolName: "bash", args: { command: "ls" } }
    }),
    ev("r-1", "tool_call_started", {
      stepIndex: 0,
      toolCallId: "call-2",
      payload: { toolName: "read_file", args: { path: "a" } }
    }),
    ev("r-1", "approval_asked", { toolCallId: "call-1", payload: { toolName: "bash" } }),
    ev("r-1", "approval_decided", { toolCallId: "call-1", payload: { approved: true } }),
    ev("r-1", "tool_call_completed", {
      stepIndex: 0,
      toolCallId: "call-1",
      payload: { toolName: "bash", status: "success", output: "ok", toolExecMs: 51, approvalWaitMs: 402_926, queueWaitMs: 0 }
    }),
    ev("r-1", "tool_call_completed", {
      stepIndex: 0,
      toolCallId: "call-2",
      payload: { toolName: "read_file", status: "success", output: "a", toolExecMs: 5, approvalWaitMs: 0, queueWaitMs: 3 }
    }),
    // 前台子代理(agent=taskId)的工具调用与主 Agent 同序列
    ev("r-1", "tool_call_started", {
      stepIndex: 0,
      agent: "task-9",
      toolCallId: "call-3",
      payload: { toolName: "subagent", args: { prompt: "go" } }
    }),
    ev("r-1", "tool_call_completed", {
      stepIndex: 0,
      agent: "task-9",
      toolCallId: "call-3",
      payload: { toolName: "subagent", status: "success", toolExecMs: 900 }
    }),
    ev("r-1", "model_call_completed", { stepIndex: 0, attempt: 1 }),
    ev("r-1", "step_completed", { stepIndex: 0, durationMs: 1200 }),
    ev("r-1", "assistant_message", { payload: { text: "做完了", toolCallCount: 3 } }),
    ev("r-1", "turn_completed", { turnIndex: 0, durationMs: 2000 }),
    ev("r-1", "run_completed", { durationMs: 2100 })
  ];
};

describe("deriveTrajectory(T53)", () => {
  it("同一份事件数组两次调用输出深相等;乱序输入结果一致", () => {
    const events = buildEvents();
    const first = deriveTrajectory(events);
    const second = deriveTrajectory(events);
    expect(first).toEqual(second);

    const shuffled = [...events].sort(() => 0.5 - Math.random());
    expect(deriveTrajectory(shuffled)).toEqual(first);
  });

  it("并行工具调用并列成行;审批并进 Tool 行不单独占行;前台子代理带 taskId", () => {
    const rows = deriveTrajectory(buildEvents());
    const tools = rows.filter((row) => row.kind === "tool");
    expect(tools).toHaveLength(3);
    expect(rows.some((row) => row.kind === "approval")).toBe(false);

    const bash = tools.find((row) => row.toolCallId === "call-1")!;
    expect(bash.status).toBe("success");
    expect(bash.timing).toMatchObject({
      execMs: 51,
      approvalWaitMs: 402_926,
      approvalAsked: true,
      approvalApproved: true
    });

    const subCall = tools.find((row) => row.toolCallId === "call-3")!;
    expect(subCall.agent).toBe("task-9");

    // Turn → Step → Request → Assistant → Tool 结构齐
    expect(rows.some((row) => row.kind === "user")).toBe(true);
    expect(rows.some((row) => row.kind === "system")).toBe(true);
    expect(rows.some((row) => row.kind === "assistant")).toBe(true);
    const assistant = rows.find((row) => row.kind === "assistant")!;
    expect(assistant.timing?.ttftMs).toBe(320);
    expect(assistant.title).toBe("做完了");
  });

  it("后台子 Run 嵌到发起它的 Tool 行下;锚点未加载先不显示", () => {
    const subRun: SubRunSummaryDto = {
      runId: "child-run",
      parentRunId: "r-1",
      backgroundTaskId: "task-1",
      subagentType: "explorer",
      parentToolCallId: "call-3",
      status: "completed",
      eventCount: 12,
      firstOccurredAtMs: 1100,
      lastOccurredAtMs: 2000
    };

    // 锚点 call-3 在 → 挂上去
    const withAnchor = deriveTrajectory(buildEvents(), [subRun]);
    const anchorTool = withAnchor.find((row) => row.toolCallId === "call-3")!;
    expect(anchorTool.children).toHaveLength(1);
    expect(anchorTool.children![0]).toMatchObject({
      kind: "subtool",
      runId: "child-run",
      status: "success"
    });

    // 锚点不在(只翻了第一页)→ 静默不显示,不报错
    const withoutAnchor = deriveTrajectory(buildEvents().slice(0, 4), [subRun]);
    expect(withoutAnchor.every((row) => row.kind !== "subtool")).toBe(true);
  });

  it("未知 kind 降级成 raw 行,投影不崩", () => {
    const rows = deriveTrajectory([
      ev("r-1", "future_kind_v2", { payload: { any: "thing" } })
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "raw", title: "future_kind_v2" });
  });

  it("abandoned 工具调用关成行并标 aborted", () => {
    seq = 0;
    const rows = deriveTrajectory([
      ev("r-1", "tool_call_started", {
        toolCallId: "call-1",
        payload: { toolName: "bash", args: {} }
      }),
      ev("r-1", "tool_call_abandoned", {
        toolCallId: "call-1",
        durationMs: 1234,
        payload: { toolName: "bash", decomposed: false }
      })
    ]);
    const tool = rows.find((row) => row.kind === "tool")!;
    expect(tool.status).toBe("aborted");
    expect(tool.durationMs).toBe(1234);
  });
});

describe("resolveSnapshotForRow(T54)", () => {
  it("request_snapshot_ref 顺 refSeq 取回正文;ref 只在同 Run 内有效", async () => {
    const { resolveSnapshotForRow } = await import(
      "../../../apps/web/src/features/threads/trajectory/snapshot.js"
    );
    seq = 0;
    const events = [
      ev("r-1", "request_snapshot", { payload: { systemPrompt: "v1-prompt", modelId: "m" } }),
      ev("r-1", "tool_call_started", { toolCallId: "c-1", payload: {} }),
      ev("r-1", "request_snapshot_ref", { payload: { refSeq: 0 } }),
      ev("r-1", "tool_call_started", { toolCallId: "c-2", payload: {} })
    ];

    // ref 后的工具行(seq 3)顺 ref 取回 seq 0 的正文
    expect(resolveSnapshotForRow(events, "r-1", 3)).toEqual({
      systemPrompt: "v1-prompt",
      modelId: "m"
    });
    // 同 Run 外的行取不到(ref 只在同 Run 内有效)
    expect(resolveSnapshotForRow(events, "r-other", 3)).toBeUndefined();
    // 第一条 snapshot 之前的行 → undefined,不伪造
    expect(resolveSnapshotForRow(events, "r-1", -1)).toBeUndefined();
  });
});
