import { describe, expect, it } from "vitest";

import { createReportTool } from "../../../packages/harness/src/subagents/report-tool.js";
import {
  formatSubagentNotice,
  type SubagentNotice
} from "../../../packages/harness/src/subagents/types.js";

/** 把 AgentTool 的 execute 拉出来单独调(不跑 Agent)。 */
const exec = (tool: { tool: { execute?: unknown } }) =>
  (input: Record<string, unknown>): Promise<string> => {
    if (!tool.tool.execute) throw new Error("report tool missing execute");
    return tool.tool.execute(input as never) as Promise<string>;
  };

const notice = (over: Partial<SubagentNotice> = {}): SubagentNotice => ({
  kind: "reported",
  taskId: "t_abc",
  parentToolCallId: "call_00",
  subagentType: "explorer",
  description: "深挖 apps/server",
  output: "结论:三层依赖结构",
  ...over
});

describe("report 工具 (S7 push:子代理主动交付)", () => {
  it("调用后把 output 交给 sink", async () => {
    const got: string[] = [];
    const tool = createReportTool((output) => got.push(output));

    const out = await exec(tool)({ output: "结论:A 比 B 快" });

    expect(got).toEqual(["结论:A 比 B 快"]);
    expect(out).toContain("Reported");
  });

  it("允许多次 report(中途发现也能先交)", async () => {
    const got: string[] = [];
    const tool = createReportTool((output) => got.push(output));

    await exec(tool)({ output: "进度:读完 10 个文件" });
    await exec(tool)({ output: "最终:结论如下" });

    expect(got).toHaveLength(2);
    expect(got[1]).toBe("最终:结论如下");
  });

  it("空 output 被 schema 拒(不静默交一条空报告)", async () => {
    const got: string[] = [];
    const tool = createReportTool((output) => got.push(output));

    const out = await exec(tool)({ output: "" });

    expect(out).toContain("Error:");
    expect(got).toEqual([]);
  });

  it("是只读工具(不进审批)", () => {
    expect(createReportTool(() => {}).readOnly).toBe(true);
  });
});

describe("formatSubagentNotice (注入给模型的文本)", () => {
  it("reported → 带 description 与内容", () => {
    const text = formatSubagentNotice(notice());

    expect(text).toContain("t_abc");
    expect(text).toContain("深挖 apps/server");
    expect(text).toContain("reported:");
    expect(text).toContain("结论:三层依赖结构");
  });

  it("settled → 说明它不会再干活,不诱导去查询", () => {
    const text = formatSubagentNotice(notice({ kind: "settled", output: undefined }));

    expect(text).toContain("finished and will do no further work");
    // 关键:通知里绝不能出现"去查一下结果"这类话术(轮询的诱因)。
    expect(text).not.toMatch(/poll|check again|TaskOutput/i);
  });

  it("settled 带收尾语时一并附上", () => {
    const text = formatSubagentNotice(
      notice({ kind: "settled", output: "已交付完整报告" })
    );

    expect(text).toContain("Its closing message:");
    expect(text).toContain("已交付完整报告");
  });
});
