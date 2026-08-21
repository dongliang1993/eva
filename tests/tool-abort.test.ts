import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  buildTool,
  type ToolExecutionOptions,
} from "../packages/harness/src/index.js";

const hungSchema = z.object({ a: z.number() });

/** 手动控制 resolve 时机的 promise —— 制造"execute 开始后才 abort"的窗口。 */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const optWith = (abortSignal?: AbortSignal): ToolExecutionOptions => ({
  toolCallId: "t-abort",
  ...(abortSignal !== undefined ? { abortSignal } : {}),
});

describe("buildTool abortSignal 透传 + race 兜底(T25)", () => {
  it("挂死工具 + 已 abort 的 signal → 立即返回 [Tool Error],不再悬着", async () => {
    const hung = buildTool({
      name: "hung",
      description: "never resolves",
      inputSchema: hungSchema,
      execute: () => new Promise<string>(() => {}),
    });
    const controller = new AbortController();
    controller.abort();
    const res = await hung.tool.execute!(
      { a: 1 },
      optWith(controller.signal) as never,
    );
    expect(String(res)).toContain("[Tool Error]");
  });

  it("execute 开始后才 abort → race 在 abort 时点返回错误文本", async () => {
    const gate = deferred<string>();
    const tool = buildTool({
      name: "gated",
      description: "resolves only when the gate opens",
      inputSchema: hungSchema,
      execute: () => gate.promise,
    });
    const controller = new AbortController();
    const pending = tool.tool.execute!(
      { a: 1 },
      optWith(controller.signal) as never,
    );
    setTimeout(() => controller.abort(), 10);
    const res = await pending;
    expect(String(res)).toContain("[Tool Error]");
    expect(String(res)).toMatch(/abort|cancel|timed?/i);
  });

  it("正常完成先于 abort → 业务返回值原样透传", async () => {
    const tool = buildTool({
      name: "fast",
      description: "resolves immediately",
      inputSchema: hungSchema,
      execute: async () => "done-quick",
    });
    const controller = new AbortController();
    const res = await tool.tool.execute!(
      { a: 1 },
      optWith(controller.signal) as never,
    );
    expect(res).toBe("done-quick");
  });

  it("execute 收到的 options 带上 abortSignal(透传断言)", async () => {
    const seen = vi.fn();
    const tool = buildTool({
      name: "echo",
      description: "records options",
      inputSchema: hungSchema,
      execute: async (_input, options) => {
        seen(options);
        return "ok";
      },
    });
    const controller = new AbortController();
    await tool.tool.execute!({ a: 1 }, optWith(controller.signal) as never);
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "t-abort",
        abortSignal: controller.signal,
      }),
    );
  });

  it("无 signal → 行为与现状一致(正常返回;抛错仍包 [Tool Error])", async () => {
    const ok = buildTool({
      name: "ok",
      description: "fine",
      inputSchema: hungSchema,
      execute: async () => "plain",
    });
    expect(await ok.tool.execute!({ a: 1 }, optWith() as never)).toBe("plain");

    const boom = buildTool({
      name: "boom",
      description: "throws",
      inputSchema: hungSchema,
      execute: async () => {
        throw new Error("kaput");
      },
    });
    const res = await boom.tool.execute!({ a: 1 }, optWith() as never);
    expect(String(res)).toContain("[Tool Error]");
    expect(String(res)).toContain("kaput");
  });

  it("工具返回后 signal 才 abort → 监听器已清理,不抛不告警", async () => {
    const tool = buildTool({
      name: "quick2",
      description: "finishes then signal fires",
      inputSchema: hungSchema,
      execute: async () => "done",
    });
    const controller = new AbortController();
    const res = await tool.tool.execute!(
      { a: 1 },
      optWith(controller.signal) as never,
    );
    expect(res).toBe("done");
    controller.abort(); // 工具已 settle,race 输家的监听器应已被移除,不抛
  });
});
