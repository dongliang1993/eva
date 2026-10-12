import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { textOf, tool } from "../../../packages/harness/src/index.js";
import { runTool } from "../../helpers/run-tool.js";
import type { ToolExtra } from "../../../packages/harness/src/query/types.js";

const hungSchema = z.object({ a: z.number() });

/** 手动控制 resolve 时机的 promise —— 制造"execute 开始后才 abort"的窗口。 */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const extraWith = (signal?: AbortSignal): Partial<ToolExtra> => ({
  toolUseID: "t-abort",
  ...(signal !== undefined ? { signal } : {}),
});

describe("tool() cooperative cancellation", () => {
  it("挂死工具 + 已 abort 的 signal → 立即返回 Error:,不再悬着", async () => {
    const hung = tool({
      name: "hung",
      description: "never resolves",
      inputSchema: hungSchema,
      execute: () => new Promise(() => {}),
    });
    const controller = new AbortController();
    controller.abort();
    const res = await runTool(hung, { a: 1 }, extraWith(controller.signal));
    expect(textOf(res)).toContain("Error:");
  });

  it("取消必须等待执行真正结束", async () => {
    const gate = deferred<string>();
    const gated = tool({
      name: "gated",
      description: "resolves only when the gate opens",
      inputSchema: hungSchema,
      execute: () => gate.promise.then((value) => ({
        content: [{ type: "text", text: value }],
      })),
    });
    const controller = new AbortController();
    const pending = runTool(gated, { a: 1 }, extraWith(controller.signal));
    let settled = false;
    void Promise.resolve(pending).then(() => { settled = true; });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve("execution completed");
    expect(textOf(await pending)).toBe("execution completed");
  });

  it("正常完成先于 abort → 业务返回值原样透传", async () => {
    const fast = tool({
      name: "fast",
      description: "resolves immediately",
      inputSchema: hungSchema,
      execute: async () => ({
        content: [{ type: "text", text: "done-quick" }],
      }),
    });
    const controller = new AbortController();
    const res = await runTool(fast, { a: 1 }, extraWith(controller.signal));
    expect(textOf(res)).toBe("done-quick");
  });

  it("execute 收到的 extra 带上 signal(透传断言)", async () => {
    const seen = vi.fn();
    const spy = tool({
      name: "echo",
      description: "records extra",
      inputSchema: hungSchema,
      execute: async (_input, extra) => {
        seen(extra);
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const controller = new AbortController();
    await runTool(spy, { a: 1 }, extraWith(controller.signal));
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseID: "t-abort",
        signal: controller.signal,
      }),
    );
  });

  it("无 signal → 行为与现状一致(正常返回;抛错仍包 Error:)", async () => {
    const ok = tool({
      name: "ok",
      description: "fine",
      inputSchema: hungSchema,
      execute: async () => ({
        content: [{ type: "text", text: "plain" }],
      }),
    });
    expect(textOf(await runTool(ok, { a: 1 }))).toBe("plain");

    const boom = tool({
      name: "boom",
      description: "throws",
      inputSchema: hungSchema,
      execute: async () => {
        throw new Error("kaput");
      },
    });
    const res = await runTool(boom, { a: 1 });
    expect(textOf(res)).toContain("Error:");
    expect(textOf(res)).toContain("kaput");
  });

  it("工具返回后 signal 才 abort → 监听器已清理,不抛不告警", async () => {
    const quick = tool({
      name: "quick2",
      description: "finishes then signal fires",
      inputSchema: hungSchema,
      execute: async () => ({
        content: [{ type: "text", text: "done" }],
      }),
    });
    const controller = new AbortController();
    const res = await runTool(quick, { a: 1 }, extraWith(controller.signal));
    expect(textOf(res)).toBe("done");
    controller.abort(); // 工具已 settle,race 输家的监听器应已被移除,不抛
  });
});
