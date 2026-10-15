import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { createSubagentToolDefinition } from "../../../packages/harness/src/query/subagent-tool.js";
import { createSideChannel } from "../../../packages/harness/src/query/side-channel.js";
import type { HarnessMessage } from "../../../packages/harness/src/query/types.js";
import { toToolSet } from "../../../packages/harness/src/tools/tool.js";
import { runToolText } from "../../helpers/run-tool.js";

const usage = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
  raw: undefined,
};

/** 文本收尾的最小子代理模型。 */
const textModel = (text: string): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: text },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: "stop", usage },
        ],
      }),
    }),
  });

/** explorer 子代理的父 options(agents 非空 → subagent 工具注册)。 */
const optionsWithExplorer = (
  languageModel: MockLanguageModelV4 = textModel("ok"),
) => ({
  model: { languageModel, id: "mock:model" },
  agents: {
    explorer: {
      description: "读文档并摘要",
      prompt: "You are an explorer.",
    },
  } as const,
});

describe("subagent 原语 (S7 push 模型)", () => {
  it("只暴露一个工具 —— 没有 join/查询接口(轮询的结构性根源)", () => {
    // createSubagentTool(runFork) 已删:同一信息由 createSubagentToolDefinition
    // (内置 subagent 工具,单工具名 "subagent")承担。
    const tool = createSubagentToolDefinition({
      options: optionsWithExplorer(),
      channel: createSideChannel<HarnessMessage>(),
    });

    expect(tool?.name).toBe("subagent");
  });

  it("agents 为空 → 不注册(undefined)", () => {
    const tool = createSubagentToolDefinition({
      options: { model: { languageModel: textModel("ok"), id: "mock:model" }, agents: {} },
      channel: createSideChannel<HarnessMessage>(),
    });

    expect(tool).toBeUndefined();
  });

  it("等待子代理完成后返回结论", async () => {
    // 子代理模型把 prompt 原样收进文本 → 父拿到子代理的最终 result 文本。
    const childModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "FINAL: digest README" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: "stop", usage },
          ],
        }),
      }),
    });
    const tool = createSubagentToolDefinition({
      options: optionsWithExplorer(childModel),
      channel: createSideChannel<HarnessMessage>(),
    });
    expect(tool).toBeDefined();
    if (tool === undefined) throw new Error("unreachable");

    expect(
      await runToolText(
        tool,
        { description: "读 README", prompt: "digest README", subagent: "explorer" },
      ),
    ).toBe("FINAL: digest README");
  });

  it("description 必填 —— 缺了就报错(否则卡片无法分辨)", async () => {
    const tool = createSubagentToolDefinition({
      options: optionsWithExplorer(),
      channel: createSideChannel<HarnessMessage>(),
    });
    expect(tool).toBeDefined();
    if (tool === undefined) throw new Error("unreachable");

    // zod min(1) 校验失败 → execute 兜成 Error: 文本(不抛)。
    const out = await runToolText(tool, {
      prompt: "做点什么",
      subagent: "explorer",
    } as Record<string, unknown>);

    expect(out).toContain("Error:");
  });

  it("未知 subagent 类型 → Error: 文本(isError)", async () => {
    const tool = createSubagentToolDefinition({
      options: optionsWithExplorer(),
      channel: createSideChannel<HarnessMessage>(),
    });
    expect(tool).toBeDefined();
    if (tool === undefined) throw new Error("unreachable");

    const out = await runToolText(tool, {
      description: "查一下",
      prompt: "p",
      subagent: "nonexistent",
    });

    expect(out).toContain("Error:");
    expect(out).toContain("Unknown subagent type: nonexistent");
  });

  it("进 toolSet 后名字是 subagent(供 SDK 装配)", () => {
    const tool = createSubagentToolDefinition({
      options: optionsWithExplorer(),
      channel: createSideChannel<HarnessMessage>(),
    });
    expect(tool).toBeDefined();
    if (tool === undefined) throw new Error("unreachable");

    expect(Object.keys(toToolSet([tool]))).toEqual(["subagent"]);
  });
});
