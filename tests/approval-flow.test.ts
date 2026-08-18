import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { createAgent } from "../packages/harness/src/agents/create-agent.js";
import type { AgentStreamEvent } from "../packages/harness/src/agents/types.js";
import { APPROVAL_DENIED_PREFIX, withApproval } from "../packages/harness/src/tools/with-approval.js";
import { buildTool } from "../packages/harness/src/tools.js";
import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { ApprovalRepository } from "../apps/server/src/db/repositories/approval-repository.js";
import { ApprovalGateway } from "../apps/server/src/services/approval-gateway.js";

type FinishEvent = Extract<AgentStreamEvent, { type: "finish" }>;

const isFinish = (event: AgentStreamEvent): event is FinishEvent =>
  event.type === "finish";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

/**
 * 造一个「第一步调 `toolName`,第二步输出文本」的两步 mock 流。
 * 第 2 步的模型调用会带上第 1 步的 tool-result(SDK 自回灌),所以第 2 步
 * 直接产纯文本即可 —— 这正好覆盖真实场景:工具执行完模型继续说话。
 */
const toolCallThenTextModel = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCallId = "tc-1"
): MockLanguageModelV4 => {
  let callIndex = 0;

  return new MockLanguageModelV4({
    doStream: async () => {
      const call = callIndex;
      callIndex += 1;

      if (call === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: toolCallId, toolName },
              {
                type: "tool-call",
                toolCallId,
                toolName,
                input: JSON.stringify(toolInput)
              },
              { type: "finish", finishReason: "tool-calls" as const, usage }
            ]
          })
        };
      }

      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "The answer is: 42" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: "stop" as const, usage }
          ]
        })
      };
    }
  });
};

const readFileTool = () =>
  buildTool({
    name: "read_file",
    description: "read a file",
    schema: z.object({ path: z.string() }),
    readOnly: true,
    execute: async (input: { path: string }) => `content of ${input.path}`
  });

const dangerousTool = () =>
  buildTool({
    name: "dangerous_a",
    description: "a dangerous tool",
    schema: z.object({ value: z.string() }),
    requiresApproval: true,
    execute: async () => "executed dangerous_a"
  });

describe("withApproval 单元", () => {
  it("只读工具不经过审批:原样返回,spy 未调用", () => {
    const spy = vi.fn();
    const tool = readFileTool();

    expect(withApproval(tool, spy)).toBe(tool);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("agent 级审批流", () => {
  it("允许 → 危险工具真的执行,且 requestApproval 收到正确参数", async () => {
    const dangerous = dangerousTool();
    const approvals: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];
    const approve = vi.fn(async (req: { toolName: string; toolCallId: string; args: unknown }) => {
      approvals.push(req);
      return true;
    });

    const agent = createAgent({
      model: toolCallThenTextModel("dangerous_a", { value: "x" }),
      tools: [dangerous],
      requestApproval: approve
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.stream({
      messages: [{ role: "user", content: "hi" }]
    })) {
      events.push(event);
    }

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      toolName: "dangerous_a",
      toolCallId: "tc-1",
      args: { value: "x" }
    });

    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults.length).toBeGreaterThan(0);
    // 工具真的执行了:输出是 execute 的返回值,不是 [Approval Denied]
    expect((toolResults[0] as { output: string }).output).toContain("executed dangerous_a");

    expect(events.some((e) => e.type === "error")).toBe(false);
    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.finishReason).toBe("stop");
    expect(finishes[0]?.text).toBe("The answer is: 42");
  });

  it("拒绝 → 危险工具不执行,模型收到 [Approval Denied] 文本", async () => {
    const dangerous = dangerousTool();
    const approve = vi.fn().mockResolvedValue(false);

    const agent = createAgent({
      model: toolCallThenTextModel("dangerous_a", { value: "x" }),
      tools: [dangerous],
      requestApproval: approve
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.stream({
      messages: [{ role: "user", content: "hi" }]
    })) {
      events.push(event);
    }

    expect(approve).toHaveBeenCalledTimes(1);

    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults.length).toBeGreaterThan(0);
    const output = (toolResults[0] as { output: string }).output;
    expect(output.startsWith(APPROVAL_DENIED_PREFIX)).toBe(true);
    // 拒绝时绝不真的执行
    expect(output).not.toContain("executed dangerous_a");

    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("agent 级回归(只读工具全链路)", () => {
  it("工具真的执行并可读到输出,(T0.4 之前的两个报错回归)", async () => {
    const model = toolCallThenTextModel("read_file", { path: "a.ts" });
    let requestApprovalCalls = 0;

    const agent = createAgent({
      model,
      tools: [readFileTool()],
      requestApproval: async () => {
        requestApprovalCalls += 1;
        return true;
      }
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.stream({
      messages: [{ role: "user", content: "hi" }]
    })) {
      events.push(event);
    }

    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults.length).toBeGreaterThan(0);
    expect((toolResults[0] as { output: string }).output).toContain("content of a.ts");

    expect(events.some((e) => e.type === "error")).toBe(false);
    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.finishReason).toBe("stop");
    // 只读工具不该问审批
    expect(requestApprovalCalls).toBe(0);
  });
});

describe("ApprovalGateway.cancelBySession", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("cancelBySession 让 pending 审批立刻按拒绝返回,repo 状态为 denied", async () => {
    const gateway = new ApprovalGateway(new ApprovalRepository(db));
    const askPromise = gateway.ask("c1", "session-1", "dangerous_a", {});

    const cancelled = gateway.cancelBySession("session-1");
    expect(cancelled).toBe(1);
    await expect(askPromise).resolves.toBe(false);

    const repo = new ApprovalRepository(db);
    expect(repo.getById("c1")?.status).toBe("denied");
  });

  it("只取消目标会话的 pending,其他会话不动", () => {
    const gateway = new ApprovalGateway(new ApprovalRepository(db));
    // other 会话的审批故意不 resolve(靠超时兜底),这里不 await
    gateway.ask("c-other", "session-2", "x", {});
    gateway.ask("c-target", "session-1", "y", {});

    expect(gateway.cancelBySession("session-1")).toBe(1);
    expect(gateway.listPending("session-1")).toHaveLength(0);
    expect(gateway.listPending("session-2")).toHaveLength(1);
  });
});