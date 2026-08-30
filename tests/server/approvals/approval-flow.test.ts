import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { createAgent } from "../../../packages/harness/src/agents/agent.js";
import type { AgentStreamEvent } from "../../../packages/harness/src/agents/types.js";
import { APPROVAL_DENIED_PREFIX, withApproval } from "../../../packages/harness/src/tools/with-approval.js";
import { buildTool } from "../../../packages/harness/src/tools/build-tool.js";
import { closeDb, initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { ApprovalRepository } from "../../../apps/server/src/modules/approvals/index.js";
import { ApprovalGateway } from "../../../apps/server/src/modules/approvals/index.js";

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
    inputSchema: z.object({ path: z.string() }),
    readOnly: true,
    execute: async (input: { path: string }) => `content of ${input.path}`
  });

const dangerousTool = () =>
  buildTool({
    name: "dangerous_a",
    description: "a dangerous tool",
    inputSchema: z.object({ value: z.string() }),
    needsApproval: true,
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

describe("ApprovalGateway.cancelByRun", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("cancelByRun 让 pending 审批立刻按拒绝返回,repo 状态为 denied", async () => {
    const gateway = new ApprovalGateway(new ApprovalRepository(db));
    const askPromise = gateway.ask("c1", {
      runId: "run-1",
      sessionId: "session-1",
      tool: "dangerous_a",
      args: {}
    });

    const cancelled = gateway.cancelByRun("run-1");
    expect(cancelled).toBe(1);
    await expect(askPromise).resolves.toBe(false);

    const repo = new ApprovalRepository(db);
    expect(repo.getById("c1")?.status).toBe("denied");
  });

  it("只取消目标 run 的 pending,其他 run 不动", () => {
    const gateway = new ApprovalGateway(new ApprovalRepository(db));
    // other run 的审批故意不 resolve(审批不超时,只能被 decide/cancelByRun 收),这里不 await
    gateway.ask("c-other", { runId: "run-2", sessionId: "session-2", tool: "x", args: {} });
    gateway.ask("c-target", { runId: "run-1", sessionId: "session-1", tool: "y", args: {} });

    expect(gateway.cancelByRun("run-1")).toBe(1);
    expect(gateway.listPending("session-1")).toHaveLength(0);
    expect(gateway.listPending("session-2")).toHaveLength(1);

    // 收尾:未决的 ask 只能靠 cancelByRun 收 —— 不收就是一个悬挂 Promise
    gateway.cancelByRun("run-2");
  });
});
/**
 * 审批不超时(plan 决定③)。刷新页面后卡片还能回来、用户能慢慢看清楚再决定 ——
 * 倒计时会把这条路重新掐断,所以这里用假时钟把「不自动拒绝」钉死。
 */
describe("审批不超时", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDb(db);
  });

  it("挂 10 分钟也不自动拒绝,仍然 pending", async () => {
    const gateway = new ApprovalGateway(new ApprovalRepository(db));
    let settled = false;
    const asked = gateway
      .ask("c1", { runId: "run-1", sessionId: "session-1", tool: "bash", args: {} })
      .then((allowed) => {
        settled = true;
        return allowed;
      });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(settled).toBe(false);
    expect(gateway.listPending("session-1")).toHaveLength(1);
    expect(new ApprovalRepository(db).getById("c1")?.status).toBe("pending");

    // 只有人工决策能把它收掉。
    expect(gateway.decide("c1", true)).toBe(true);
    await expect(asked).resolves.toBe(true);
  });
});

/**
 * 审批不超时的连带:内存待决表随进程消失,DB 里的 pending 行没人收就永远挂着
 * (那些会话会一直显示"待决策",并被并发守卫的 409 挡住新消息)。
 * 进程重启是它们唯一的收尾时机 —— deps.buildInfrastructure 启动时扫这一刀。
 */
describe("启动清扫:遗留 pending 审批", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("failStalePending 把上次遗留的 pending 收成 denied,已决策的不动", () => {
    const repo = new ApprovalRepository(db);
    repo.create({ id: "c1", sessionId: "s1", runId: "run-1", tool: "bash", args: {} });
    repo.create({ id: "c2", sessionId: "s1", runId: "run-1", tool: "bash", args: {} });
    repo.create({ id: "c3", sessionId: "s2", runId: "run-2", tool: "bash", args: {} });
    repo.decide("c3", "granted");

    expect(repo.failStalePending()).toBe(2);

    expect(repo.getById("c1")?.status).toBe("denied");
    expect(repo.getById("c1")?.decidedAt).toBeTruthy();
    expect(repo.getById("c2")?.status).toBe("denied");
    // 上一进程真的做过决策的那条保持原样。
    expect(repo.getById("c3")?.status).toBe("granted");

    // 幂等:再扫一次没有可收的了。
    expect(repo.failStalePending()).toBe(0);
  });
});

/**
 * T29:bash 只读命令直放(docs/plans/r7/T29)。
 * 短路由 harness 的 withApproval 做(requestApproval 不被调),台账由 server 的
 * requestApproval 回调做(autoApprove 落 granted)—— 两处用同一个 isSafeReadOnlyCommand。
 */
describe("bash 只读直放(T29)", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  const bashTool = () =>
    buildTool({
      name: "bash",
      description: "run a shell command",
      inputSchema: z.object({ command: z.string(), description: z.string() }),
      needsApproval: true,
      execute: async () => "ran"
    });

  const runOnce = async (command: string) => {
    const spy = vi.fn(async () => true);
    const agent = createAgent({
      model: toolCallThenTextModel("bash", { command, description: "d" }),
      tools: [bashTool()],
      requestApproval: spy
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.stream({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }
    const toolResults = events.filter((e) => e.type === "tool-result");
    return { spy, toolResults };
  };

  it("ls -la 直放:requestApproval 未被调,工具真执行", async () => {
    const { spy, toolResults } = await runOnce("ls -la");
    expect(spy).not.toHaveBeenCalled();
    expect((toolResults[0] as { output: string }).output).toBe("ran");
  });

  it("git status 直放;cat a.ts 直放", async () => {
    for (const command of ["git status", "cat a.ts"]) {
      const { spy, toolResults } = await runOnce(command);
      expect(spy).not.toHaveBeenCalled();
      expect((toolResults[0] as { output: string }).output).toBe("ran");
    }
  });

  it("ls > out.txt 仍弹审批(重定向不直放)", async () => {
    const { spy } = await runOnce("ls > out.txt");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ls && rm x 仍弹审批(拼接不直放)", async () => {
    const { spy } = await runOnce("ls && rm x");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("台账:server 回调对只读命令 autoApprove 落 granted + reason=readonly-safe,无 pending", () => {
    // 模拟 runs.ts requestApproval 回调的开头分支(§2.3)。
    const repo = new ApprovalRepository(db);
    const gateway = new ApprovalGateway(repo);

    gateway.autoApprove(
      "call-ro",
      { runId: "run-1", sessionId: "s-1", tool: "bash", args: { command: "ls -la" } },
      "readonly-safe"
    );

    const row = repo.getById("call-ro");
    expect(row?.status).toBe("granted");
    expect(row?.reason).toBe("readonly-safe");
    expect(gateway.listPending("s-1")).toHaveLength(0);
  });
});
