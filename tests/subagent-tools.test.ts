import { describe, expect, it } from "vitest";

import { createSubagentTool } from "../packages/harness/src/subagents/subagent-tool.js";
import { toToolSet } from "../packages/harness/src/tools/build-tool.js";

/** 把一个 AgentTool 的 execute 拉出来可单独调用(测试不用跑 Agent)。 */
const exec =
  (name: string, tools: readonly { name: string; tool: { execute?: unknown } }[]) =>
  (input: Record<string, unknown>): Promise<string> => {
    const t = tools.find((tool) => tool.name === name);
    if (!t?.tool.execute) throw new Error(`tool ${name} missing execute`);
    return t.tool.execute(input as never) as Promise<string>;
  };

describe("subagent 原语 (S7 push 模型)", () => {
  it("只暴露一个工具 —— 没有 join/查询接口(轮询的结构性根源)", () => {
    const tools = createSubagentTool({
      runFork: async () => ({})
    });

    expect(tools.map((t) => t.name)).toEqual(["subagent"]);
  });

  it("缺省后台 → 立刻返回任务号,并明说结果会自动送到、无需轮询", async () => {
    const seen: { background?: boolean; description?: string } = {};
    const tools = createSubagentTool({
      runFork: async ({ background, description, taskId }) => {
        seen.background = background;
        seen.description = description;
        return { taskId };
      }
    });

    const out = await exec("subagent", tools)({
      description: "深挖 apps/server",
      prompt: "调查 apps/server 的目录结构"
    });

    expect(seen.background).toBe(true);
    expect(seen.description).toBe("深挖 apps/server");
    expect(out).toMatch(/Started subagent/);
    expect(out).toContain("深挖 apps/server");
    expect(out).toContain("delivered to you");
    // 绝不能出现任何"去查/去 join"的话术,也不该再提 TaskOutput(工具已不存在)。
    expect(out).not.toMatch(/TaskOutput|poll/i);
  });

  it("run_in_background=false → 前台等到底,返回子代理交付的结论", async () => {
    const tools = createSubagentTool({
      runFork: async ({ background, prompt }) => {
        expect(background).toBe(false);
        // 子代理确实读了 README(中间步骤),但只有结论收敛出来(阀2)。
        return { text: `FINAL: ${prompt} (read README, ~2 tools)` };
      }
    });

    const out = await exec("subagent", tools)({
      description: "读 README",
      prompt: "digest README",
      run_in_background: false
    });

    expect(out).toBe("FINAL: digest README (read README, ~2 tools)");
  });

  it("description 必填 —— 缺了就报错(否则卡片无法分辨)", async () => {
    const tools = createSubagentTool({
      runFork: async () => ({ taskId: "t_x" })
    });

    const out = await exec("subagent", tools)({ prompt: "做点什么" });

    expect(out).toContain("[Tool Error]");
  });

  it("缺省角色是 explorer", async () => {
    let got = "";
    const tools = createSubagentTool({
      runFork: async ({ subagentType, taskId }) => {
        got = subagentType;
        return { taskId };
      }
    });

    await exec("subagent", tools)({ description: "查一下", prompt: "p" });

    expect(got).toBe("explorer");
  });

  it("fork 的 parentToolCallId 用 SDK 的 toolCallId(卡片归位的键)", async () => {
    let got = "";
    const tools = createSubagentTool({
      runFork: async ({ parentToolCallId, taskId }) => {
        got = parentToolCallId;
        return { taskId };
      }
    });

    const tool = tools[0]!.tool as {
      execute: (i: unknown, o: { toolCallId: string }) => Promise<string>;
    };
    await tool.execute(
      { description: "查一下", prompt: "p" },
      { toolCallId: "call_00_REAL" }
    );

    expect(got).toBe("call_00_REAL");
  });

  it("进 toolSet 后名字是 subagent(供 SDK 装配)", () => {
    const tools = createSubagentTool({
      runFork: async () => ({})
    });

    expect(Object.keys(toToolSet([...tools]))).toEqual(["subagent"]);
  });
});
