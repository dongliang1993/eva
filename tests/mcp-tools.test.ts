import { describe, expect, it, vi } from "vitest";

import type { McpServerRow } from "../apps/server/src/db/repositories/mcp-server-repository.js";
import type { McpToolDescriptor } from "../apps/server/src/services/mcp/mcp-client.js";
import {
  mcpToolName,
  toAgentTools,
  toToolSummaries,
  type McpToolInvoker,
} from "../apps/server/src/services/mcp/mcp-tools.js";

const TOOL_CALL_OPTIONS = { messages: [], toolCallId: "c1", context: {} };

const server = (over: Partial<McpServerRow> = {}): McpServerRow => ({
  id: "s1",
  name: "km",
  origin: "manual",
  transport: "stdio",
  command: "x",
  args: [],
  env: {},
  url: null,
  headers: {},
  autoApproveTools: [],
  enabled: true,
  createdAt: "now",
  updatedAt: "now",
  ...over,
});

const descriptor = (
  over: Partial<McpToolDescriptor> = {},
): McpToolDescriptor => ({
  name: "search",
  description: "Search the knowledge base",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  },
  readOnly: false,
  ...over,
});

const invoker = (
  tools: readonly McpToolDescriptor[],
  callTool: McpToolInvoker["callTool"] = async () => "ok",
): McpToolInvoker => ({ tools, callTool });

describe("mcpToolName", () => {
  it("用双下划线拼成 mcp__server__tool", () => {
    expect(mcpToolName("km", "search")).toBe("mcp__km__search");
  });
});

describe("toAgentTools", () => {
  it("readOnlyHint 为真 → 免审批", () => {
    const [tool] = toAgentTools(
      server(),
      invoker([descriptor({ readOnly: true })]),
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    expect(tool?.name).toBe("mcp__km__search");
    expect(tool?.readOnly).toBe(true);
    expect(tool?.needsApproval).toBeUndefined();
  });

  it("命中 autoApproveTools 白名单 → 免审批（白名单写 MCP 侧原名）", () => {
    const [tool] = toAgentTools(
      server({ autoApproveTools: ["search"] }),
      invoker([descriptor()]),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );

    expect(tool?.needsApproval).toBeUndefined();
  });

  it("既非只读也不在白名单 → 需要审批", () => {
    const [tool] = toAgentTools(server(), invoker([descriptor()]), {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    expect(tool?.needsApproval).toBe(true);
  });

  it("JSON Schema 原样交给工具，execute 转调 client.callTool", async () => {
    const callTool = vi.fn(async () => "hit");
    const [tool] = toAgentTools(server(), invoker([descriptor()], callTool), {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    const result = await tool!.tool.execute!({ q: "eva" }, TOOL_CALL_OPTIONS);

    // T25:execute 把 options.abortSignal 透传给 invoker(无信号时是 undefined)。
    expect(callTool).toHaveBeenCalledWith("search", { q: "eva" }, undefined);
    expect(String(result)).toBe("hit");
  });

  it("client.callTool 抛错 → 返回 Error: 文本而不是抛出", async () => {
    const [tool] = toAgentTools(
      server(),
      invoker([descriptor()], async () => {
        throw new Error("Request timed out");
      }),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );

    const result = await tool!.tool.execute!({ q: "x" }, TOOL_CALL_OPTIONS);

    expect(String(result)).toContain("Error:");
    expect(String(result)).toContain("timed out");
  });

  it("T25:execute 收到 abortSignal → 原样传给 invoker.callTool 第三参", async () => {
    const callTool = vi.fn(async () => "hit");
    const [tool] = toAgentTools(server(), invoker([descriptor()], callTool), {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    const controller = new AbortController();
    await tool!.tool.execute!(
      { q: "eva" },
      { ...TOOL_CALL_OPTIONS, abortSignal: controller.signal },
    );

    expect(callTool).toHaveBeenCalledWith(
      "search",
      { q: "eva" },
      controller.signal,
    );
  });

  it("工具名超长 → 跳过并 warn（不静默截断，也不废掉整个 server）", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tools = toAgentTools(
      server({ name: "a-very-long-server-name-that-eats-the-budget" }),
      invoker([
        descriptor({ name: "an-extremely-long-tool-name-beyond-any-limit" }),
        descriptor(),
      ]),
      logger,
    );

    expect(tools.map((t) => t.name)).toEqual([
      "mcp__a-very-long-server-name-that-eats-the-budget__search",
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("toToolSummaries", () => {
  it("给 UI 的摘要带 autoApproved 标记", () => {
    const summaries = toToolSummaries(
      server({ autoApproveTools: ["b"] }),
      invoker([
        descriptor({ name: "a", readOnly: true }),
        descriptor({ name: "b" }),
        descriptor({ name: "c" }),
      ]),
    );

    expect(summaries).toEqual([
      {
        name: "a",
        description: "Search the knowledge base",
        autoApproved: true,
      },
      {
        name: "b",
        description: "Search the knowledge base",
        autoApproved: true,
      },
      {
        name: "c",
        description: "Search the knowledge base",
        autoApproved: false,
      },
    ]);
  });
});
