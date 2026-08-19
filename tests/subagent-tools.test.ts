import { describe, expect, it } from "vitest";

import { createTaskTools } from "../packages/harness/src/subagents/task-tools.js";
import { InMemoryTaskStore } from "../packages/harness/src/subagents/in-memory-task-store.js";
import { toToolSet } from "../packages/harness/src/tools.js";

/** 把一个 AgentTool 的 execute 拉出来可单独调用(测试不用跑 LeadAgent)。 */
const exec =
  (name: string, tools: readonly { name: string; tool: { execute?: unknown } }[]) =>
  (input: Record<string, unknown>): Promise<string> => {
    const t = tools.find((tool) => tool.name === name);
    if (!t?.tool.execute) throw new Error(`tool ${name} missing execute`);
    return t.tool.execute(input as never) as Promise<string>;
  };

describe("task-tools fork-join 基元 (S7)", () => {
  it("未知 taskId → TaskOutput 返回可读错误(不静默吞)", async () => {
    const store = new InMemoryTaskStore();
    const tools = createTaskTools({
      taskStore: store,
      runFork: async () => ({})
    });
    const out = await exec("TaskOutput", tools)({ taskId: "t_nope" });
    expect(out).toContain("[Task Error]");
    expect(out).toContain("Unknown taskId");
  });

  it("前台 Task(background=false) → 只返回最终答案,不含中间工具输出(阀2)", async () => {
    const store = new InMemoryTaskStore();
    const runFork = async ({ taskId, prompt }: {
      background: boolean; prompt: string; subagentType: string; taskId: string; parentToolCallId: string;
    }) => {
      void taskId; void prompt;
      // 子代理确实读了 README(中间步骤),但只有最终两行收敛出来。
      return { text: `FINAL: ${prompt} (read README, ~2 tools)` };
    };
    const tools = createTaskTools({ taskStore: store, runFork });

    const out = await exec("Task", tools)({ prompt: "digest README", background: false });
    expect(out).toBe("FINAL: digest README (read README, ~2 tools)");
  });

  it("后台 Task(默认) → 立刻返回任务号,由 TaskOutput join", async () => {
    const store = new InMemoryTaskStore();
    const tools = createTaskTools({
      taskStore: store,
      runFork: async ({ taskId }) => ({ taskId })
    });
    const out = await exec("Task", tools)({ prompt: "grep the logs" });
    expect(out).toMatch(/Started subagent task/);
    expect(out).toMatch(/TaskOutput/);
  });

  it("TaskOutput(block=true) 等到底 → 返回子代理结果", async () => {
    const store = new InMemoryTaskStore();
    await store.create({
      id: "t_fin", sessionId: "s1", parentToolCallId: "task-t_fin",
      subagentType: "explorer", depth: 0
    });
    await store.settle("t_fin", { result: "the answer is 42" });
    const tools = createTaskTools({ taskStore: store, runFork: async () => ({}) });

    const out = await exec("TaskOutput", tools)({ taskId: "t_fin", block: true });
    expect(out).toBe("the answer is 42");
  });

  it("子代理失败 → TaskOutput 拿到 [Task Error] + 真实信息", async () => {
    const store = new InMemoryTaskStore();
    await store.create({
      id: "t_fail", sessionId: "s1", parentToolCallId: "task-t_fail",
      subagentType: "explorer", depth: 0
    });
    await store.settle("t_fail", { error: "subagent threw: stdin closed" });
    const tools = createTaskTools({ taskStore: store, runFork: async () => ({}) });

    const out = await exec("TaskOutput", tools)({ taskId: "t_fail", block: true });
    expect(out).toContain("subagent threw");
  });
});

describe("InMemoryTaskStore 超时语义", () => {
  it("running 任务 waitFor 超时 → 返回当前 running 快照(不永久阻塞)", async () => {
    const store = new InMemoryTaskStore();
    await store.create({
      id: "t_hang", sessionId: "s1", parentToolCallId: "task-t_hang",
      subagentType: "explorer", depth: 0
    });
    const out = await store.waitFor("t_hang", 30);
    expect(out?.id).toBe("t_hang");
    expect(out?.status).toBe("running");
  });
});
