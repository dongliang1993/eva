import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Semaphore } from "../../../packages/harness/src/tools/concurrency-cap.js";
import { textResult, tool } from "../../../packages/harness/src/tools/tool.js";
import { runToolCall, type ToolCallContext, type ToolTimingMutable } from "../../../packages/harness/src/query/tool-call.js";
import type { HookCallbackMatcher, HookInput, PermissionResult, ToolExtra } from "../../../packages/harness/src/query/types.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const extraOf = (overrides: Partial<ToolExtra> = {}): ToolExtra => ({
  toolUseID: "tc-1",
  signal: new AbortController().signal,
  ...overrides,
});

const ctxOf = (overrides: Partial<ToolCallContext> = {}): ToolCallContext => ({
  canUseTool: undefined,
  readOnlyLimiter: new Semaphore(10),
  timings: new Map<string, ToolTimingMutable>(),
  hooks: {},
  ...overrides,
});

const timingOf = (ctx: ToolCallContext, id = "tc-1") =>
  ctx.timings.get(id) ?? {
    approval_wait_ms: -1, queue_wait_ms: -1, exec_ms: -1, aborted: false,
  };

const echo = (annotations?: { readOnlyHint?: boolean }) =>
  tool({
    name: "echo",
    description: "e",
    inputSchema: z.object({ msg: z.string() }),
    ...(annotations ? { annotations } : {}),
    execute: async (input: { msg: string }) => textResult(`out:${input.msg}`),
  });

describe("runToolCall 生命周期", () => {
  it("PreToolUse deny:结果 = deny 文案,execute 不跑,Post hooks 不触发", async () => {
    let executed = 0;
    let postRan = 0;
    const target = tool({
      name: "write",
      description: "w",
      inputSchema: z.object({}),
      execute: async () => { executed += 1; return textResult("written"); },
    });
    const pre: HookCallbackMatcher = {
      matcher: undefined,
      hooks: [async () => ({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "policy says no",
        },
      })],
    };
    const post: HookCallbackMatcher = {
      matcher: undefined,
      hooks: [async () => { postRan += 1; return {}; }],
    };
    const ctx = ctxOf({ hooks: { PreToolUse: [pre], PostToolUse: [post] } });
    const { result, interruptTurn } = await runToolCall(target, {}, extraOf(), ctx);

    expect(interruptTurn).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("policy says no");
    expect(executed).toBe(0);
    expect(postRan).toBe(0);
    // hook deny 不是故障:三段全 0(没进权限、没排队、没执行)。
    expect(timingOf(ctx)).toEqual({
      approval_wait_ms: 0, queue_wait_ms: 0, exec_ms: 0, aborted: false,
    });
  });

  it("被 canUseTool deny 的调用:message 原样给模型,isError=false;不写 exec 计时", async () => {
    const target = tool({
      name: "write",
      description: "w",
      inputSchema: z.object({ path: z.string() }),
      execute: async () => textResult("should not run"),
    });
    const ctx = ctxOf({
      canUseTool: async (): Promise<PermissionResult> => ({
        behavior: "deny",
        message: "[Approval Denied] The user rejected the `write` call.",
      }),
    });
    const { result, interruptTurn } = await runToolCall(target, { path: "a" }, extraOf(), ctx);
    expect(interruptTurn).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("[Approval Denied]");
    expect(timingOf(ctx).exec_ms).toBe(0);
  });

  it("deny.interrupt=true → interruptTurn=true(本轮在这步后结束)", async () => {
    const target = tool({
      name: "exit_plan_mode",
      description: "x",
      inputSchema: z.object({}),
      execute: async () => textResult("should not run"),
    });
    const ctx = ctxOf({
      canUseTool: async (): Promise<PermissionResult> => ({
        behavior: "deny",
        message: "Error: Plan rejected. Plan mode remains active.",
        interrupt: true,
        isError: true,
      }),
    });
    const { result, interruptTurn } = await runToolCall(target, {}, extraOf(), ctx);
    expect(interruptTurn).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Error: Plan rejected. Plan mode remains active.");
  });

  it("deny.isError=true → message 加 Error: 前缀、isError=true(plan gate reject 语义)", async () => {
    const target = tool({
      name: "exit_plan_mode",
      description: "x",
      inputSchema: z.object({}),
      execute: async () => textResult("nope"),
    });
    const ctx = ctxOf({
      canUseTool: async (): Promise<PermissionResult> => ({
        behavior: "deny",
        message: "Plan rejected. Plan mode remains active.",
        isError: true,
      }),
    });
    const { result } = await runToolCall(target, {}, extraOf(), ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Error: Plan rejected. Plan mode remains active.");
  });

  it("allow.updatedInput 替换传给 execute 的 input(exit_plan_mode 决策注入)", async () => {
    let seen: unknown;
    // passthrough:决策字段不在 schema 里,parse 不得 strip(exit_plan_mode 的
    // decision 注入就是这条路)。
    const target = tool({
      name: "exit_plan_mode",
      description: "x",
      inputSchema: z.object({}).passthrough(),
      execute: async (input) => {
        seen = input;
        return textResult("approved");
      },
    });
    const ctx = ctxOf({
      canUseTool: async (): Promise<PermissionResult> => ({
        behavior: "allow",
        updatedInput: { decision: "approve", revision: 3 },
      }),
    });
    const { result } = await runToolCall(target, { decision: undefined }, extraOf(), ctx);
    expect(result.content[0]?.text).toBe("approved");
    expect(seen).toEqual({ decision: "approve", revision: 3 });
  });

  it("三段计时:审批 100ms / 排队 40ms+ / 执行 45ms+ 三个独立数字", async () => {
    // 非只读工具才走 canUseTool(FR-004:readOnlyHint 直放不调它)。
    // 先占住唯一帽位,150ms 后释放:审批等 100ms 结束后帽还被占 → 排队等待确定 > 40ms。
    const limiter = new Semaphore(1);
    const hold = await limiter.acquire();
    const ctx = ctxOf({
      canUseTool: async () => {
        await sleep(100);
        return { behavior: "allow" } as const;
      },
      readOnlyLimiter: limiter,
    });
    const slowEcho = tool({
      name: "bash",
      description: "slow bash",
      inputSchema: z.object({ msg: z.string() }),
      execute: async () => {
        await sleep(50);
        return textResult("slow");
      },
    });
    setTimeout(() => hold(), 150);
    const { result } = await runToolCall(slowEcho, { msg: "x" }, extraOf(), ctx);
    expect(result.content[0]?.text).toBe("slow");

    const t = timingOf(ctx);
    expect(t.approval_wait_ms).toBeGreaterThanOrEqual(90);
    // 非只读不吃并发帽(FR-004 顺序里帽只在 readOnlyHint 分支)→ 排队 0。
    expect(t.queue_wait_ms).toBe(0);
    expect(t.exec_ms).toBeGreaterThanOrEqual(45);
    const total = t.approval_wait_ms + t.queue_wait_ms + t.exec_ms;
    expect(total).toBeGreaterThan(t.approval_wait_ms);
    expect(total).toBeGreaterThan(t.exec_ms);
  });

  it("无审批无排队的只读工具:两个等待字段是 0", async () => {
    const ctx = ctxOf({
      canUseTool: async () => ({ behavior: "allow" } as const),
    });
    await runToolCall(echo({ readOnlyHint: true }), { msg: "a" }, extraOf(), ctx);
    const t = timingOf(ctx);
    expect(t.approval_wait_ms).toBe(0);
    expect(t.queue_wait_ms).toBeLessThan(30);
    expect(t.exec_ms).toBeGreaterThanOrEqual(0);
  });

  it("写工具不吃只读帽:并发位立即通过", async () => {
    const limiter = new Semaphore(1);
    const hold = await limiter.acquire();
    const ctx = ctxOf({
      canUseTool: async () => ({ behavior: "allow" } as const),
      readOnlyLimiter: limiter,
    });
    const started = Date.now();
    await runToolCall(echo(), { msg: "a" }, extraOf(), ctx); // 无 readOnlyHint
    expect(Date.now() - started).toBeLessThan(50);
    hold();
  });

  it("execute 抛错 → 兜底 errorResult,走 PostToolUseFailure,计时保留 exec", async () => {
    const failures: HookInput[] = [];
    const failureHook: HookCallbackMatcher = {
      matcher: undefined,
      hooks: [async (input) => { failures.push(input); return {}; }],
    };
    const target = tool({
      name: "boom",
      description: "b",
      inputSchema: z.object({}),
      execute: async () => {
        await sleep(30);
        throw new Error("kaput");
      },
    });
    const ctx = ctxOf({
      canUseTool: async () => ({ behavior: "allow" } as const),
      hooks: { PostToolUseFailure: [failureHook] },
    });
    const { result } = await runToolCall(target, {}, extraOf(), ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Error: kaput");
    expect(failures).toHaveLength(1);
    // tool() 的 guard 把抛错兜成结构化失败,error 字段是模型可见文本(带前缀)。
    expect(failures[0]).toMatchObject({
      hook_event_name: "PostToolUseFailure",
      tool_name: "boom",
      error: "Error: kaput",
      is_interrupt: false,
    });
    expect(timingOf(ctx).exec_ms).toBeGreaterThanOrEqual(25);
    expect(timingOf(ctx).aborted).toBe(false);
  });

  it("execute 返回 isError=true(结构化失败)→ 同样走 PostToolUseFailure", async () => {
    const failures: string[] = [];
    const ctx = ctxOf({
      canUseTool: async () => ({ behavior: "allow" } as const),
      hooks: {
        PostToolUseFailure: [{
          matcher: undefined,
          hooks: [async (input) => {
            failures.push((input as { error: string }).error);
            return {};
          }],
        }],
      },
    });
    const target = tool({
      name: "fail",
      description: "f",
      inputSchema: z.object({}),
      execute: async () => ({
        content: [{ type: "text", text: "Error: before text not found." }],
        isError: true,
      }),
    });
    await runToolCall(target, {}, extraOf(), ctx);
    expect(failures).toEqual(["Error: before text not found."]);
  });

  it("Post hooks 收到响应与三段计时对应的关系;成功走 PostToolUse 不走 Failure", async () => {
    const posts: HookInput[] = [];
    const ctx = ctxOf({
      canUseTool: async () => ({ behavior: "allow" } as const),
      hooks: {
        PostToolUse: [{
          matcher: undefined,
          hooks: [async (input) => { posts.push(input); return {}; }],
        }],
      },
    });
    await runToolCall(echo(), { msg: "hi" }, extraOf(), ctx);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_name: "echo",
      tool_response: { content: [{ type: "text", text: "out:hi" }] },
    });
  });

  it("入参 signal 已 abort → aborted() 结果,不进 execute", async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = 0;
    const target = tool({
      name: "slow",
      description: "s",
      inputSchema: z.object({}),
      execute: async () => { executed += 1; return textResult("late"); },
    });
    const { result } = await runToolCall(
      target, {}, extraOf({ signal: controller.signal }), ctxOf({
        canUseTool: async () => ({ behavior: "allow" } as const),
      }),
    );
    expect(result.content[0]?.text).toBe("Error: tool call aborted");
    expect(result.isError).toBe(true);
    expect(executed).toBe(0);
  });

  it("排队中 abort(readOnly 帽位等待时)→ Failure 且 is_interrupt=true", async () => {
    const controller = new AbortController();
    const limiter = new Semaphore(1);
    const hold = await limiter.acquire();
    const failures: HookInput[] = [];
    const ctx = ctxOf({
      canUseTool: async () => ({ behavior: "allow" } as const),
      readOnlyLimiter: limiter,
      hooks: {
        PostToolUseFailure: [{
          matcher: undefined,
          hooks: [async (input) => { failures.push(input); return {}; }],
        }],
      },
    });
    const target = echo({ readOnlyHint: true });
    const pending = runToolCall(
      target, { msg: "x" }, extraOf({ signal: controller.signal }), ctx,
    );
    setTimeout(() => controller.abort(), 20);
    const { result } = await pending;
    expect(result.isError).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ is_interrupt: true });
    hold();
  });

  it("PreToolUse hook 抛错 → 本次调用失败(execute 不跑),走 PostToolUseFailure", async () => {
    let executed = 0;
    const target = tool({
      name: "write",
      description: "w",
      inputSchema: z.object({}),
      execute: async () => { executed += 1; return textResult("written"); },
    });
    const failures: string[] = [];
    const ctx = ctxOf({
      hooks: {
        PreToolUse: [{
          matcher: undefined,
          hooks: [async () => { throw new Error("intent write failed"); }],
        }],
        PostToolUseFailure: [{
          matcher: undefined,
          hooks: [async (input) => {
            failures.push((input as { error: string }).error);
            return {};
          }],
        }],
      },
    });
    const { result } = await runToolCall(target, {}, extraOf(), ctx);
    expect(executed).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("intent write failed");
    expect(failures).toEqual(["intent write failed"]);
  });
});
