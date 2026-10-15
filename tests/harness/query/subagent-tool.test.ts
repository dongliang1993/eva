import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { query } from "../../../packages/harness/src/query/query.js";
import { resolveSubagentTools } from "../../../packages/harness/src/query/subagent-tool.js";
import { textResult, tool } from "../../../packages/harness/src/tools/tool.js";
import type {
  HarnessMessage,
  HookCallback,
  Options,
} from "../../../packages/harness/src/query/types.js";

/**
 * 内置 subagent 工具(Claude Code Agent 工具同款)经父 query() 端到端驱动。
 * 父模型第一步派子代理,子代理跑完后父第二步收尾。
 */

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const text = (id: string, body: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id },
  { type: "text-delta", id, delta: body },
  { type: "text-end", id },
  { type: "finish", finishReason: "stop", usage },
];

const dispatch = (input: Record<string, unknown>) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: "call-sub", toolName: "subagent", input: JSON.stringify(input) },
  { type: "finish", finishReason: "tool-calls", usage },
];

/** 按调用序号给 chunk;记下每次请求的 prompt 与工具名。 */
const scripted = (turns: readonly (readonly unknown[])[]) => {
  const prompts: unknown[] = [];
  const toolNames: string[][] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      toolNames.push((options.tools ?? []).map((t) => t.name));
      const chunks = turns[Math.min(call, turns.length - 1)] ?? [];
      call += 1;
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  });
  return { model, prompts, toolNames };
};

const echo = (name: string) => tool({
  name, description: name, inputSchema: z.object({}),
  execute: async () => textResult(`${name} ran`),
});

const collect = async (q: AsyncIterable<HarnessMessage>): Promise<HarnessMessage[]> => {
  const out: HarnessMessage[] = [];
  for await (const m of q) out.push(m);
  return out;
};

const label = (m: HarnessMessage): string =>
  `${m.parent_tool_use_id ?? "main"}:${m.type}${"subtype" in m ? `/${m.subtype}` : ""}`;

describe("内置 subagent 工具", () => {
  it("消息序:父 tool-call → task_started → 子代理全部(带 parent_tool_use_id)→ task_notification → 父 tool-result", async () => {
    const parent = scripted([dispatch({ description: "d", prompt: "dig", subagent: "explorer" }), text("p", "parent done")]);
    const child = scripted([text("c", "child answer")]);

    const messages = await collect(query({
      prompt: [{ role: "user", content: "go" }],
      options: {
        model: { languageModel: parent.model as never, id: "m:parent" },
        canUseTool: async () => ({ behavior: "allow" }),
        agents: {
          explorer: {
            description: "explores",
            prompt: "You are an explorer.",
            model: { languageModel: child.model as never, id: "m:child" },
          },
        },
      },
    }));

    const seq = messages
      .filter((m) => m.type !== "stream_event")
      .map(label);
    const iCall = seq.indexOf("main:assistant");
    const iStart = seq.indexOf("main:system/task_started");
    const iChildInit = seq.indexOf("call-sub:system/init");
    const iChildResult = seq.indexOf("call-sub:result/success");
    const iNotify = seq.indexOf("main:system/task_notification");
    const iParentUser = seq.indexOf("main:user");
    expect([iCall, iStart, iChildInit, iChildResult, iNotify, iParentUser])
      .toEqual([...[iCall, iStart, iChildInit, iChildResult, iNotify, iParentUser]].sort((a, b) => a - b));
    expect(iCall).toBeGreaterThanOrEqual(0);
    expect(seq.at(-1)).toBe("main:result/success");

    const notify = messages.find((m) => m.type === "system" && m.subtype === "task_notification");
    expect(notify).toMatchObject({ status: "completed", summary: "child answer", tool_use_id: "call-sub" });
    const started = messages.find((m) => m.type === "system" && m.subtype === "task_started");
    expect(started).toMatchObject({ task_type: "explorer", description: "d", prompt: "dig", tool_use_id: "call-sub" });
    // task_id 与 notification 同一个(同一次派发)
    if (started?.type !== "system" || started.subtype !== "task_started") throw new Error("unreachable");
    expect(notify).toMatchObject({ task_id: started.task_id });

    // 父看到的工具结果 = 子代理的结论
    const parentUser = messages.find((m) => m.type === "user" && m.parent_tool_use_id === null);
    if (parentUser?.type !== "user" || typeof parentUser.message.content === "string") throw new Error("unreachable");
    const part = parentUser.message.content[0];
    expect(part?.type === "tool-result" && part.output).toEqual({ type: "text", value: "child answer" });
  });

  it("子代理是全新上下文:只有定义的 system prompt + 一条任务;看不到父对话", async () => {
    const parent = scripted([dispatch({ description: "d", prompt: "the task", subagent: "explorer" }), text("p", "ok")]);
    const child = scripted([text("c", "done")]);
    await collect(query({
      prompt: [{ role: "user", content: "SECRET parent context" }],
      options: {
        model: { languageModel: parent.model as never, id: "m:p" },
        canUseTool: async () => ({ behavior: "allow" }),
        agents: {
          explorer: {
            description: "e", prompt: "You are an explorer.",
            model: { languageModel: child.model as never, id: "m:c" },
          },
        },
      },
    }));

    const childPrompt = JSON.stringify(child.prompts[0]);
    expect(childPrompt).toContain("You are an explorer.");
    expect(childPrompt).toContain("the task");
    expect(childPrompt).not.toContain("SECRET parent context");
  });

  it("工具:继承父工具 → tools 白名单 → disallowedTools;subagent 自身恒不给", async () => {
    const parent = scripted([dispatch({ description: "d", prompt: "t", subagent: "explorer" }), text("p", "ok")]);
    const child = scripted([text("c", "done")]);
    await collect(query({
      prompt: [{ role: "user", content: "go" }],
      options: {
        model: { languageModel: parent.model as never, id: "m:p" },
        tools: [echo("read_file"), echo("grep"), echo("write")],
        canUseTool: async () => ({ behavior: "allow" }),
        agents: {
          explorer: {
            description: "e", prompt: "p",
            tools: ["read_file", "grep", "subagent"],
            disallowedTools: ["grep"],
            model: { languageModel: child.model as never, id: "m:c" },
          },
        },
      },
    }));
    expect(parent.toolNames[0]).toContain("subagent");
    // tool_search 是 pipeline 恒注入的发现入口
    expect(child.toolNames[0]?.filter((n) => n !== "tool_search")).toEqual(["read_file"]);

    // 省略 tools = 继承全部(仍不含 subagent)
    expect(resolveSubagentTools([echo("a"), echo("subagent")], { description: "", prompt: "" })
      .map((t) => t.name)).toEqual(["a"]);
  });

  it("身份:子代理的工具调用经同一 canUseTool / hooks,agentID = task_id;主 agent 不带", async () => {
    const parent = scripted([
      [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "call-main", toolName: "write", input: "{}" },
        { type: "tool-call", toolCallId: "call-sub", toolName: "subagent",
          input: JSON.stringify({ description: "d", prompt: "t", subagent: "worker" }) },
        { type: "finish", finishReason: "tool-calls", usage },
      ],
      text("p", "ok"),
    ]);
    const child = scripted([
      [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "call-child", toolName: "write", input: "{}" },
        { type: "finish", finishReason: "tool-calls", usage },
      ],
      text("c", "done"),
    ]);
    const permissionCalls: Array<[string, string | undefined]> = [];
    const hookAgents: Array<[string, string | undefined]> = [];
    const pre: HookCallback = async (input) => {
      if (input.hook_event_name === "PreToolUse") hookAgents.push([input.tool_use_id, input.agent_id]);
      return {};
    };

    const messages = await collect(query({
      prompt: [{ role: "user", content: "go" }],
      options: {
        model: { languageModel: parent.model as never, id: "m:p" },
        tools: [echo("write")],
        canUseTool: async (_name, _input, opts) => {
          permissionCalls.push([opts.toolUseID, opts.agentID]);
          return { behavior: "allow" };
        },
        hooks: { PreToolUse: [{ hooks: [pre] }] },
        agents: {
          worker: { description: "w", prompt: "p", model: { languageModel: child.model as never, id: "m:c" } },
        },
      },
    }));

    const started = messages.find((m) => m.type === "system" && m.subtype === "task_started");
    if (started?.type !== "system" || started.subtype !== "task_started") throw new Error("unreachable");
    const taskId = started.task_id;
    expect(taskId).toMatch(/^a[0-9a-f]{16}$/);
    expect(permissionCalls).toContainEqual(["call-main", undefined]);
    expect(permissionCalls).toContainEqual(["call-sub", undefined]);
    expect(permissionCalls).toContainEqual(["call-child", taskId]);
    expect(hookAgents).toContainEqual(["call-child", taskId]);
    expect(hookAgents).toContainEqual(["call-main", undefined]);
  });

  it("abort:父 interrupt 传到子代理(子的 result=interrupted,父拿到 isError 结果)", async () => {
    const controller = new AbortController();
    const parent = scripted([dispatch({ description: "d", prompt: "t", subagent: "slow" }), text("p", "ok")]);
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    const slowTool = tool({
      name: "slow", description: "s", inputSchema: z.object({}),
      execute: async (_input, extra) => {
        childStarted();
        await new Promise<void>((resolve) => extra.signal.addEventListener("abort", () => resolve(), { once: true }));
        return textResult("never");
      },
    });
    const child = scripted([[
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "call-slow", toolName: "slow", input: "{}" },
      { type: "finish", finishReason: "tool-calls", usage },
    ], text("c", "should not reach")]);

    const q = query({
      prompt: [{ role: "user", content: "go" }],
      options: {
        model: { languageModel: parent.model as never, id: "m:p" },
        tools: [slowTool],
        abortController: controller,
        canUseTool: async () => ({ behavior: "allow" }),
        agents: { slow: { description: "s", prompt: "p", model: { languageModel: child.model as never, id: "m:c" } } },
      },
    });
    const messagesP = collect(q);
    await started;
    controller.abort();
    const messages = await messagesP;

    const childResult = messages.find((m) => m.type === "result" && m.parent_tool_use_id === "call-sub");
    expect(childResult).toMatchObject({ subtype: "interrupted" });
    expect(messages.find((m) => m.type === "system" && m.subtype === "task_notification"))
      .toMatchObject({ status: "stopped" });
    expect(messages.at(-1)).toMatchObject({ type: "result", subtype: "interrupted", parent_tool_use_id: null });
    // 子代理模型只被调用一次(abort 后不再续跑)
    expect(child.prompts).toHaveLength(1);
  });

  it("未知类型 / 子代理失败 → isError 结果,父循环继续", async () => {
    const parent = scripted([dispatch({ description: "d", prompt: "t", subagent: "nope" }), text("p", "ok")]);
    const messages = await collect(query({
      prompt: [{ role: "user", content: "go" }],
      options: {
        model: { languageModel: parent.model as never, id: "m:p" },
        canUseTool: async () => ({ behavior: "allow" }),
        agents: { explorer: { description: "e", prompt: "p" } },
      },
    }));
    const user = messages.find((m) => m.type === "user");
    if (user?.type !== "user" || typeof user.message.content === "string") throw new Error("unreachable");
    const part = user.message.content[0];
    expect(part?.type === "tool-result" && part.output).toMatchObject({ type: "error-text" });
    expect(messages.at(-1)).toMatchObject({ type: "result", subtype: "success" });
  });

  it("agents 为空不注册;与 tools 里的同名 subagent 冲突 → query() 同步抛", () => {
    const base: Options = { model: { languageModel: scripted([]).model as never, id: "m" } };
    expect(() => query({ prompt: [], options: { ...base, agents: {} } })).not.toThrow();
    expect(() => query({
      prompt: [],
      options: { ...base, tools: [echo("subagent")], agents: { x: { description: "x", prompt: "x" } } },
    })).toThrow(/Duplicate tool name: subagent/);
  });
});
