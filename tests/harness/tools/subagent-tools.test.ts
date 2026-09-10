import { describe, expect, it } from "vitest";

import { createSubagentTool } from "../../../packages/harness/src/subagents/subagent-tool.js";
import { toToolSet } from "../../../packages/harness/src/tools/build-tool.js";

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

  it("等待子代理完成后返回结论", async () => {
    const tools = createSubagentTool({
      runFork: async ({ prompt }) => ({ text: `FINAL: ${prompt}` })
    });
    expect(await exec("subagent", tools)({ description: "读 README", prompt: "digest README" }))
      .toBe("FINAL: digest README");
  });

  it("description 必填 —— 缺了就报错(否则卡片无法分辨)", async () => {
    const tools = createSubagentTool({
      runFork: async () => ({ taskId: "t_x" })
    });

    const out = await exec("subagent", tools)({ prompt: "做点什么" });

    expect(out).toContain("Error:");
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
