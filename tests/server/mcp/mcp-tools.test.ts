import { describe, expect, it, vi } from "vitest";

import type { McpServerConfig } from "../../../packages/shared/src/index.js";
import type { McpToolDescriptor } from "../../../apps/server/src/modules/mcp/index.js";
import {
  mcpToolName,
  toAgentTools,
  toToolSummaries,
  type McpToolInvoker,
} from "../../../apps/server/src/modules/mcp/index.js";
import { runToolText } from "../../helpers/run-tool.js";



const server = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: "km",
  name: "km",
  transport: "stdio",
  command: "x",
  args: [],
  env: {},
  headers: {},
  autoApproveTools: [],
  enabled: true,
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
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("命中 autoApproveTools 白名单 → UI 摘要标 autoApproved(权限链统一判定)", () => {
    const [summary] = toToolSummaries(
      server({ autoApproveTools: ["search"] }),
      invoker([descriptor()]),
    );

    expect(summary.autoApproved).toBe(true);
  });

  it("既非只读也不在白名单 → UI 摘要不免审批(权限链问人)", () => {
    const [summary] = toToolSummaries(server(), invoker([descriptor()]));

    expect(summary.autoApproved).toBe(false);
  });

  it("JSON Schema 原样交给工具，execute 转调 client.callTool", async () => {
    const callTool = vi.fn(async () => "hit");
    const [tool] = toAgentTools(server(), invoker([descriptor()], callTool), {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    const result = await runToolText(tool!, { q: "eva" }, { toolUseID: "c1" });

    // runTool 造了未 abort 的 signal 透传给 invoker。
    expect(callTool).toHaveBeenCalledWith("search", { q: "eva" }, expect.any(AbortSignal));
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

    const result = await runToolText(tool!, { q: "x" }, { toolUseID: "c1" });

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
    await runToolText(tool!, { q: "eva" }, { toolUseID: "c1", signal: controller.signal });

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
  it("给 UI 的摘要带 autoApproved 标记与参数表", () => {
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
        // inputSchema.properties/required 派生成参数表(声明序)
        params: [
          { name: "q", type: "string", required: true, description: "" }
        ],
      },
      {
        name: "b",
        description: "Search the knowledge base",
        autoApproved: true,
        params: [{ name: "q", type: "string", required: true, description: "" }],
      },
      {
        name: "c",
        description: "Search the knowledge base",
        autoApproved: false,
        params: [{ name: "q", type: "string", required: true, description: "" }],
      },
    ]);
  });

  it("params:required 缺席时全部可选;数组 type 折成 a | b;描述透传", () => {
    const [summary] = toToolSummaries(
      server(),
      invoker([
        descriptor({
          inputSchema: {
            type: "object",
            properties: {
              pageId: {
                type: "number",
                description: "Targets a specific page by ID."
              },
              dblClick: { type: "boolean", description: "Set to true for double clicks." },
              either: { type: ["string", "null"] }
            }
          }
        }),
      ]),
    );

    expect(summary.params).toEqual([
      {
        name: "pageId",
        type: "number",
        required: false,
        description: "Targets a specific page by ID."
      },
      {
        name: "dblClick",
        type: "boolean",
        required: false,
        description: "Set to true for double clicks."
      },
      { name: "either", type: "string | null", required: false, description: "" }
    ]);
  });

  it("params:inputSchema 不是对象形状 → 空参数表", () => {
    const [summary] = toToolSummaries(
      server(),
      invoker([descriptor({ inputSchema: undefined })]),
    );

    expect(summary.params).toEqual([]);
  });
});
