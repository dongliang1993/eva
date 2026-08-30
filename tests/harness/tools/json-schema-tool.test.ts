import { describe, expect, it, vi } from "vitest";

import { buildJsonSchemaTool } from "../../../packages/harness/src/tools/build-json-schema-tool.js";
import type { ToolExecutionOptions } from "../../../packages/harness/src/tools/build-tool.js";

const OPTIONS: ToolExecutionOptions = {
  messages: [],
  toolCallId: "c-js-1",
  context: {},
};

describe("buildJsonSchemaTool(T25 options 透传)", () => {
  it("definition.execute 收到 SDK 的 options(此前根本没传)", async () => {
    // T25 验收 4:MCP 工具经 buildJsonSchemaTool 也能拿到 toolCallId ——
    // 旧行为是 definition.execute(input) 连第二参数都不存在。
    const execute = vi.fn(async () => "hit");
    const tool = buildJsonSchemaTool({
      name: "mcp__km__search",
      description: "search",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      execute,
    });

    const result = await tool.tool.execute!({ q: "eva" }, OPTIONS);

    expect(String(result)).toBe("hit");
    expect(execute).toHaveBeenCalledWith({ q: "eva" }, OPTIONS);
  });

  it("abortSignal 随 options 一并透传", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => "hit");
    const tool = buildJsonSchemaTool({
      name: "mcp__km__get",
      description: "get",
      inputSchema: { type: "object" },
      execute,
    });

    await tool.tool.execute!(
      {},
      { ...OPTIONS, abortSignal: controller.signal },
    );

    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ abortSignal: controller.signal }),
    );
  });

  it("execute 抛错 → Error: 文本(既有行为回归)", async () => {
    const tool = buildJsonSchemaTool({
      name: "mcp__km__boom",
      description: "boom",
      inputSchema: { type: "object" },
      execute: async () => {
        throw new Error("connection lost");
      },
    });

    const result = await tool.tool.execute!({}, OPTIONS);
    expect(String(result)).toContain("Error:");
    expect(String(result)).toContain("connection lost");
  });

  it("readOnly / needsApproval 元数据原样带出", () => {
    const tool = buildJsonSchemaTool({
      name: "mcp__km__read",
      description: "read",
      inputSchema: { type: "object" },
      execute: async () => "ok",
      readOnly: true,
      needsApproval: true,
    });

    expect(tool.readOnly).toBe(true);
    expect(tool.needsApproval).toBe(true);
  });
});
