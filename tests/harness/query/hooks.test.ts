import { describe, expect, it } from "vitest";

import {
  runPostToolUse,
  runPostToolUseFailure,
  runPreToolUse,
} from "../../../packages/harness/src/query/hooks.js";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookInput,
} from "../../../packages/harness/src/query/types.js";

const signal = new AbortController().signal;

const hookRecorder = () => {
  const inputs: HookInput[] = [];
  const callback: HookCallback = async (input, toolUseID) => {
    inputs.push(input);
    expect(toolUseID).toBe("tc-1");
    return {};
  };
  return { inputs, callback };
};

describe("matcher 匹配", () => {
  it("matcher 省略/空串 → 匹配所有工具", async () => {
    const { inputs, callback } = hookRecorder();
    const matchers: readonly HookCallbackMatcher[] = [
      { matcher: undefined, hooks: [callback] },
      { matcher: "", hooks: [callback] },
    ];
    const outcome = await runPreToolUse({
      hooks: matchers,
      toolName: "anything_at_all",
      toolInput: {},
      toolUseID: "tc-1",
      signal,
    });
    expect(outcome.denied).toBe(false);
    expect(inputs).toHaveLength(2);
  });

  it("matcher 是工具名正则:write|edit 匹配 write,不匹配 bash", async () => {
    const seen: string[] = [];
    const callback: HookCallback = async (input) => {
      seen.push(input.tool_name);
      return {};
    };
    const matchers: readonly HookCallbackMatcher[] = [
      { matcher: "^(write|edit)$", hooks: [callback] },
    ];
    await runPreToolUse({
      hooks: matchers, toolName: "write", toolInput: {}, toolUseID: "tc-1", signal,
    });
    await runPreToolUse({
      hooks: matchers, toolName: "bash", toolInput: {}, toolUseID: "tc-1", signal,
    });
    expect(seen).toEqual(["write"]);
  });

  it("matcher 不是合法正则 → 按字面量比,不静默失明", async () => {
    const seen: string[] = [];
    const callback: HookCallback = async (input) => {
      seen.push(input.tool_name);
      return {};
    };
    const matchers: readonly HookCallbackMatcher[] = [
      { matcher: "wri(te", hooks: [callback] },
    ];
    await runPreToolUse({
      hooks: matchers, toolName: "wri(te", toolInput: {}, toolUseID: "tc-1", signal,
    });
    await runPreToolUse({
      hooks: matchers, toolName: "write", toolInput: {}, toolUseID: "tc-1", signal,
    });
    expect(seen).toEqual(["wri(te"]);
  });
});

describe("PreToolUse", () => {
  it("任一 hook 返回 deny 即停:后面的 hook 不再跑", async () => {
    const ran: string[] = [];
    const first: HookCallback = async () => {
      ran.push("first");
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "policy says no",
        },
      };
    };
    const second: HookCallback = async () => {
      ran.push("second");
      return {};
    };
    const outcome = await runPreToolUse({
      hooks: [{ matcher: undefined, hooks: [first, second] }],
      toolName: "write",
      toolInput: { path: "a" },
      toolUseID: "tc-1",
      signal,
    });
    expect(outcome).toEqual({ denied: true, message: "policy says no" });
    expect(ran).toEqual(["first"]);
  });

  it("deny 不带 reason → 默认文案;按注册顺序依次 await", async () => {
    const order: number[] = [];
    const hooks: HookCallback[] = [
      async () => { order.push(1); return {}; },
      async () => {
        order.push(2);
        return {
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
        };
      },
    ];
    const outcome = await runPreToolUse({
      hooks: [{ matcher: undefined, hooks }],
      toolName: "bash",
      toolInput: {},
      toolUseID: "tc-1",
      signal,
    });
    expect(order).toEqual([1, 2]);
    expect(outcome.denied).toBe(true);
    expect(outcome.message).toBe("Denied by PreToolUse hook.");
  });

  it("agent_id 只在子代理调用时带;主 agent 不带", async () => {
    const seen: Array<string | undefined> = [];
    const callback: HookCallback = async (input) => {
      seen.push((input as { agent_id?: string }).agent_id);
      return {};
    };
    await runPreToolUse({
      hooks: [{ matcher: undefined, hooks: [callback] }],
      toolName: "write", toolInput: {}, toolUseID: "tc-1",
      agentID: "task-9", signal,
    });
    await runPreToolUse({
      hooks: [{ matcher: undefined, hooks: [callback] }],
      toolName: "write", toolInput: {}, toolUseID: "tc-1",
      signal,
    });
    expect(seen).toEqual(["task-9", undefined]);
  });
});

describe("PostToolUse / PostToolUseFailure", () => {
  it("PostToolUse 带 tool_response 与 duration_ms,全部跑完", async () => {
    const seen: Array<HookInput> = [];
    const hooks: HookCallback[] = [
      async (input) => { seen.push(input); return {}; },
      async (input) => { seen.push(input); return {}; },
    ];
    await runPostToolUse({
      hooks: [{ matcher: undefined, hooks }],
      toolName: "read_file",
      toolInput: { path: "a" },
      toolResponse: { content: [{ type: "text", text: "ok" }] },
      toolUseID: "tc-1",
      durationMs: 42,
      signal,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_name: "read_file",
      tool_response: { content: [{ type: "text", text: "ok" }] },
      duration_ms: 42,
    });
  });

  it("PostToolUseFailure 抛错的 hook 被吞:失败报告失败不再炸收口", async () => {
    const boom: HookCallback = async () => {
      throw new Error("hook itself broke");
    };
    const ok: HookCallback = async () => ({});
    await expect(runPostToolUseFailure({
      hooks: [{ matcher: undefined, hooks: [boom, ok] }],
      toolName: "write",
      toolInput: {},
      error: "exec boom",
      isInterrupt: false,
      toolUseID: "tc-1",
      durationMs: 7,
      signal,
    })).resolves.toBeUndefined();
  });

  it("PostToolUse 的 hook 抛错往上抛(由 tool-call 折叠成本次调用失败)", async () => {
    const boom: HookCallback = async () => {
      throw new Error("observer write failed");
    };
    await expect(runPostToolUse({
      hooks: [{ matcher: undefined, hooks: [boom] }],
      toolName: "write",
      toolInput: {},
      toolResponse: { content: [{ type: "text", text: "ok" }] },
      toolUseID: "tc-1",
      durationMs: 3,
      signal,
    })).rejects.toThrow("observer write failed");
  });
});
