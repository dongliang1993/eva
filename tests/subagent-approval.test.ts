import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { ApprovalRepository } from "../apps/server/src/db/repositories/approval-repository.js";
import { ApprovalGateway } from "../apps/server/src/services/approval-gateway.js";
import { createAgent } from "../packages/harness/src/agents/agent.js";
import type { AgentStreamEvent } from "../packages/harness/src/agents/types.js";
import { buildTool } from "../packages/harness/src/tools/build-tool.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

/** 第一步调危险工具,第二步纯文本收尾。 */
const dangerousCallModel = (): MockLanguageModelV4 => {
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
              { type: "tool-input-start", id: "tc-1", toolName: "write_file" },
              { type: "tool-call", toolCallId: "tc-1", toolName: "write_file", input: JSON.stringify({ path: "a.txt" }) },
              { type: "finish", finishReason: "tool-calls", usage }
            ]
          })
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "done" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: "stop", usage }
          ]
        })
      };
    }
  });
};

const writeTool = (executed: string[]) =>
  buildTool({
    name: "write_file",
    description: "write a file",
    inputSchema: z.object({ path: z.string() }),
    needsApproval: true,
    execute: async (input: { path: string }) => {
      executed.push(input.path);
      return `wrote ${input.path}`;
    }
  });

const collect = async (agent: ReturnType<typeof createAgent>): Promise<AgentStreamEvent[]> => {
  const events: AgentStreamEvent[] = [];
  for await (const event of agent.stream({ messages: [{ role: "user", content: "hi" }] })) {
    events.push(event);
  }
  return events;
};

describe("子代理审批分支 (T17)", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  describe("ApprovalGateway.autoApprove", () => {
    it("落库即 granted、不进 pending,返回 true", () => {
      const gateway = new ApprovalGateway(new ApprovalRepository(db));

      const approved = gateway.autoApprove("call-1", {
        runId: "run-1",
        sessionId: "session-1",
        tool: "write_file",
        args: { path: "a.txt" }
      });

      expect(approved).toBe(true);
      expect(new ApprovalRepository(db).getById("call-1")?.status).toBe("granted");
      expect(gateway.listPending().map((p) => p.callId)).not.toContain("call-1");
    });

    it("自动通过的记录不被 cancelByRun 扫到;对照:ask 的 pending 会被取消成 denied", async () => {
      const gateway = new ApprovalGateway(new ApprovalRepository(db));

      gateway.autoApprove("call-auto", {
        runId: "run-1",
        sessionId: "session-1",
        tool: "write_file",
        args: {}
      });
      const asked = gateway.ask("call-pending", {
        runId: "run-1",
        sessionId: "session-1",
        tool: "bash",
        args: {}
      });

      expect(gateway.cancelByRun("run-1")).toBe(1);

      const repo = new ApprovalRepository(db);
      expect(repo.getById("call-auto")?.status).toBe("granted");
      expect(repo.getById("call-pending")?.status).toBe("denied");
      await expect(asked).resolves.toBe(false);
    });
  });

  describe("子代理危险工具过闸", () => {
    it("自动通过:工具真的执行、台账落 granted、不触发任何用户可见交互", async () => {
      const gateway = new ApprovalGateway(new ApprovalRepository(db));
      const executed: string[] = [];

      // routes/runs.ts 派生的子代理闭包同款形态:进闸门,第一个分支放行,记录照落。
      const subagentRequestApproval = async ({ toolCallId, toolName, args }: {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
      }): Promise<boolean> =>
        gateway.autoApprove(toolCallId, { runId: "run-1", sessionId: "s-1", tool: toolName, args });

      const agent = createAgent({
        model: dangerousCallModel(),
        tools: [writeTool(executed)],
        requestApproval: subagentRequestApproval
      });

      const events = await collect(agent);

      expect(executed).toEqual(["a.txt"]);
      const repo = new ApprovalRepository(db);
      expect(repo.getById("tc-1")?.status).toBe("granted");
      expect(repo.getById("tc-1")?.tool).toBe("write_file");
      // 没有待决态残留(不弹卡片、不等 decide、不吃超时)
      expect(gateway.listPending()).toHaveLength(0);
      // 工具结果正常回灌,loop 走到 finish
      const toolResults = events.filter((e) => e.type === "tool-result");
      expect(toolResults.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === "finish")).toBe(true);
    });

    it("对照:同一危险工具在主 agent 闸(ask)里 → 进 pending 等用户", async () => {
      const gateway = new ApprovalGateway(new ApprovalRepository(db));
      const executed: string[] = [];
      const emitSpy = vi.fn();

      // 主 agent 闭包形态:白名单未命中 → emit 卡片 + ask 挂起。
      const mainRequestApproval = async ({ toolCallId, toolName, args }: {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
      }): Promise<boolean> => {
        emitSpy({ type: "approval_request", callId: toolCallId, toolName });
        return gateway.ask(toolCallId, { runId: "run-1", sessionId: "s-1", tool: toolName, args });
      };

      const agent = createAgent({
        model: dangerousCallModel(),
        tools: [writeTool(executed)],
        requestApproval: mainRequestApproval
      });

      const eventsPromise = collect(agent);
      // 等 pending 出现后模拟用户批准
      await vi.waitFor(() => {
        expect(gateway.listPending().map((p) => p.callId)).toContain("tc-1");
      });
      expect(emitSpy).toHaveBeenCalledOnce();
      expect(executed).toHaveLength(0);
      gateway.decide("tc-1", true);

      await eventsPromise;
      expect(executed).toEqual(["a.txt"]);
    });
  });
});
