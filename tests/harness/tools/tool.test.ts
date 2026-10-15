import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  aborted,
  errorResult,
  textOf,
  textResult,
  tool,
  toolFromJsonSchema,
  toAiTool,
} from "../../../packages/harness/src/tools/tool.js";
import type {
  JsonSchemaInput,
  ToolExtra,
  ToolResult,
} from "../../../packages/harness/src/query/types.js";

const extraOf = (overrides: Partial<ToolExtra> = {}): ToolExtra => ({
  toolUseID: "tc-1",
  signal: new AbortController().signal,
  ...overrides,
});

describe("ToolResult 构造函数", () => {
  it("textResult 拼出模型可见文本,isError 缺省", () => {
    const result = textResult("hello");
    expect(textOf(result)).toBe("hello");
    expect(result.isError).toBeUndefined();
  });

  it("errorResult 带 Error: 前缀与 isError", () => {
    const result = errorResult("kaput");
    expect(textOf(result)).toBe("Error: kaput");
    expect(result.isError).toBe(true);
  });

  it("aborted 的文案与 isError 保持旧常量逐字一致", () => {
    const result = aborted();
    expect(textOf(result)).toBe("Error: tool call aborted");
    expect(result.isError).toBe(true);
  });
});

describe("tool()", () => {
  it("schema.parse 应用 .default() 后交给 execute", async () => {
    const execute = z.object({ n: z.number().default(7) });
    const def = tool({
      name: "d",
      description: "d",
      inputSchema: execute,
      execute: async (input) => textResult(`n=${input.n}`),
    });
    // 未给 n → parse 填默认值 7。
    const result = await def.execute({} as never, extraOf());
    expect(textOf(result)).toBe("n=7");
  });

  it("execute 抛错 → 兜成 errorResult(文案 Error: <message>)", async () => {
    const def = tool({
      name: "boom",
      description: "b",
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error("kaput");
      },
    });
    const result = await def.execute({} as never, extraOf());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Error: kaput");
  });

  it("execute 抛错且 signal 已 abort → aborted()", async () => {
    const controller = new AbortController();
    controller.abort();
    const def = tool({
      name: "boom-abort",
      description: "b",
      inputSchema: z.object({}),
      execute: async () => {
        throw controller.signal.reason ?? new Error("x");
      },
    });
    const result = await def.execute({} as never, extraOf({ signal: controller.signal }));
    expect(textOf(result)).toBe("Error: tool call aborted");
    expect(result.isError).toBe(true);
  });

  it("入参 signal 已 abort → 不调 execute,直接 aborted()", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const def = tool({
      name: "pre-abort",
      description: "b",
      inputSchema: z.object({}),
      execute: async () => {
        called = true;
        return textResult("nope");
      },
    });
    const result = await def.execute({} as never, extraOf({ signal: controller.signal }));
    expect(called).toBe(false);
    expect(textOf(result)).toBe("Error: tool call aborted");
  });

  it("schema parse 失败 → 兜成 errorResult(命令不执行)", async () => {
    const def = tool({
      name: "bad-input",
      description: "b",
      inputSchema: z.object({ required: z.string() }),
      execute: async () => textResult("should not run"),
    });
    const result = await def.execute({} as never, extraOf());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error:/);
  });

  it("json-schema inputSchema 走 tool() → 构造期抛错", () => {
    expect(() =>
      tool({
        name: "wrong",
        description: "w",
        inputSchema: { type: "json-schema", schema: { type: "object" } },
        execute: async () => textResult("x"),
      }),
    ).toThrow(TypeError);
  });
});

describe("toolFromJsonSchema()", () => {
  it("inputSchema 原样保留(不做 zod 转换)", async () => {
    const inputSchema: JsonSchemaInput = {
      type: "json-schema",
      schema: { type: "object", properties: { q: { type: "string" } } },
    };
    const def = toolFromJsonSchema({
      name: "mcp__km__search",
      description: "search",
      inputSchema,
      execute: async (input) => textResult(`got ${JSON.stringify(input)}`),
    });
    expect(def.inputSchema).toBe(inputSchema);
    const result = await def.execute({ q: "eva" }, extraOf());
    expect(textOf(result)).toBe('got {"q":"eva"}');
  });

  it("zod inputSchema 走 toolFromJsonSchema → 构造期抛错", () => {
    expect(() =>
      toolFromJsonSchema({
        name: "wrong",
        description: "w",
        inputSchema: z.object({}),
        execute: async () => textResult("x"),
      }),
    ).toThrow(TypeError);
  });
});

describe("toAiTool()", () => {
  it("execute 的返回值是 ToolResult;toModelOutput 输出 textOf(模型可见文本不变)", async () => {
    const def = tool({
      name: "echo",
      description: "e",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => textResult(`line1\n${input.msg}`),
    });
    const aiTool = toAiTool(def);
    const output = await aiTool.execute!({ msg: "line2" }, { toolCallId: "tc-ai" } as never);
    expect((output as ToolResult).isError).toBeUndefined();
    // toModelOutput:模型看到 textOf(result),不是 JSON 化的对象。
    const modelOutput = await aiTool.toModelOutput!({
      toolCallId: "tc-ai",
      input: { msg: "line2" },
      output,
    } as never);
    expect(modelOutput).toEqual({ type: "text", value: "line1\nline2" });
  });

  it("toolUseID/abortSignal 从 AI SDK options 透传给 execute", async () => {
    const controller = new AbortController();
    let seen: ToolExtra | undefined;
    const def = tool({
      name: "spy",
      description: "s",
      inputSchema: z.object({}),
      execute: async (_input, extra) => {
        seen = extra;
        return textResult("ok");
      },
    });
    const aiTool = toAiTool(def);
    await aiTool.execute!(
      {},
      { toolCallId: "tc-spy", abortSignal: controller.signal } as never,
    );
    expect(seen?.toolUseID).toBe("tc-spy");
    expect(seen?.signal).toBe(controller.signal);
  });

  it("json-schema 工具同样经 toAiTool 适配", async () => {
    const def = toolFromJsonSchema({
      name: "mcp__km__get",
      description: "get",
      inputSchema: { type: "json-schema", schema: { type: "object" } },
      execute: async () => errorResult("connection lost"),
    });
    const aiTool = toAiTool(def);
    const output = (await aiTool.execute!({}, { toolCallId: "tc-mcp" } as never)) as ToolResult;
    expect(output.isError).toBe(true);
    const modelOutput = await aiTool.toModelOutput!({
      toolCallId: "tc-mcp",
      input: {},
      output,
    } as never);
    // 失败走 error-text(provider 译成 is_error:true);文本逐字不变。
    expect(modelOutput).toEqual({ type: "error-text", value: "Error: connection lost" });
  });
});
