import { describe, expect, it, vi } from "vitest";

import { toolFromJsonSchema } from "../../../packages/harness/src/tools/tool.js";
import { runTool } from "../../helpers/run-tool.js";
import { textOf } from "../../../packages/harness/src/tools/tool.js";
import type { ToolExtra } from "../../../packages/harness/src/query/types.js";

const OPTIONS: Partial<ToolExtra> = {
  toolUseID: "c-js-1",
};

describe("toolFromJsonSchema", () => {
  it("execute 收到 input 与 extra(透传断言)", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "hit" }],
    }));
    const jsonTool = toolFromJsonSchema({
      name: "mcp__km__search",
      description: "search",
      inputSchema: { type: "json-schema", schema: { type: "object", properties: { q: { type: "string" } } } },
      execute,
    });

    const result = await runTool(jsonTool, { q: "eva" }, OPTIONS);

    expect(textOf(result)).toBe("hit");
    expect(execute).toHaveBeenCalledWith({ q: "eva" }, expect.objectContaining({ toolUseID: "c-js-1" }));
  });

  it("signal 随 extra 一并透传", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "hit" }],
    }));
    const jsonTool = toolFromJsonSchema({
      name: "mcp__km__get",
      description: "get",
      inputSchema: { type: "json-schema", schema: { type: "object" } },
      execute,
    });

    await runTool(jsonTool, {}, { ...OPTIONS, signal: controller.signal });

    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("execute 抛错 → Error: 文本(既有行为回归)", async () => {
    const jsonTool = toolFromJsonSchema({
      name: "mcp__km__boom",
      description: "boom",
      inputSchema: { type: "json-schema", schema: { type: "object" } },
      execute: async () => {
        throw new Error("connection lost");
      },
    });

    const result = await runTool(jsonTool, {}, OPTIONS);
    expect(textOf(result)).toContain("Error:");
    expect(textOf(result)).toContain("connection lost");
  });

  it("readOnlyHint / needsApproval 元数据原样带出", () => {
    const jsonTool = toolFromJsonSchema({
      name: "mcp__km__read",
      description: "read",
      inputSchema: { type: "json-schema", schema: { type: "object" } },
      annotations: { readOnlyHint: true },
      needsApproval: true,
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    expect(jsonTool.annotations?.readOnlyHint).toBe(true);
    expect(jsonTool.needsApproval).toBe(true);
  });
});
