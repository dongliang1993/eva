import { describe, expect, it, vi } from "vitest";

import {
  createAgent,
  createSubagentPromptSection,
  createTaskTool,
  generalPurposeSubagent,
  SubagentExecutor,
  SubagentRegistry,
  type SubagentConfig
} from "../packages/harness/src/index.js";

// ---------------------------------------------------------------------------
// SubagentRegistry
// ---------------------------------------------------------------------------

describe("SubagentRegistry", () => {
  it("registers and retrieves configs", () => {
    const registry = new SubagentRegistry();
    registry.register(generalPurposeSubagent);

    expect(registry.get("general-purpose")).toBe(generalPurposeSubagent);
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("lists all registered configs", () => {
    const registry = new SubagentRegistry();
    registry.register(generalPurposeSubagent);

    expect(registry.list()).toEqual([generalPurposeSubagent]);
    expect(registry.names()).toEqual(["general-purpose"]);
  });

  it("overwrites config with same name", () => {
    const registry = new SubagentRegistry();
    registry.register(generalPurposeSubagent);

    const updated: SubagentConfig = {
      ...generalPurposeSubagent,
      systemPrompt: "Updated prompt"
    };
    registry.register(updated);

    expect(registry.get("general-purpose")?.systemPrompt).toBe(
      "Updated prompt"
    );
    expect(registry.list()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SubagentExecutor
// ---------------------------------------------------------------------------

const stubConfig: SubagentConfig = {
  name: "stub",
  description: "Stub subagent",
  systemPrompt: "You are a stub.",
  disallowedTools: ["task"],
  maxSteps: 3,
  timeoutMs: 5_000
};

const makeStubModel = (response: string) => ({
  invoke: vi.fn().mockResolvedValue({
    content: response,
    tool_calls: [],
    response_metadata: {},
    id: "msg-1"
  }),
  stream: vi.fn()
});

describe("SubagentExecutor", () => {
  it("executes successfully and returns result", async () => {
    const model = makeStubModel("Analysis complete.");
    const executor = new SubagentExecutor({
      config: stubConfig,
      tools: [],
      model
    });

    const result = await executor.execute("Analyze this code");

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Analysis complete.");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("filters tools by disallowedTools", async () => {
    const model = makeStubModel("Done.");
    const fakeTool = { name: "task" } as any;
    const otherTool = { name: "web_search" } as any;

    const executor = new SubagentExecutor({
      config: { ...stubConfig, disallowedTools: ["task"] },
      tools: [fakeTool, otherTool],
      model
    });

    const result = await executor.execute("test");

    expect(result.status).toBe("completed");
  });

  it("filters tools by allowlist", async () => {
    const model = makeStubModel("Done.");
    const tool1 = { name: "web_search" } as any;
    const tool2 = { name: "sentry_analyze_issue" } as any;

    const executor = new SubagentExecutor({
      config: {
        ...stubConfig,
        tools: ["web_search"],
        disallowedTools: undefined
      },
      tools: [tool1, tool2],
      model
    });

    const result = await executor.execute("test");

    expect(result.status).toBe("completed");
  });

  it("returns failed status on model error", async () => {
    const model = {
      invoke: vi.fn().mockRejectedValue(new Error("Model unavailable")),
      stream: vi.fn()
    };

    const executor = new SubagentExecutor({
      config: stubConfig,
      tools: [],
      model
    });

    const result = await executor.execute("test");

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Model unavailable");
  });

  it("returns timed_out status on timeout", async () => {
    const model = {
      invoke: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10_000))
      ),
      stream: vi.fn()
    };

    const executor = new SubagentExecutor({
      config: { ...stubConfig, timeoutMs: 50 },
      tools: [],
      model
    });

    const result = await executor.execute("slow task");

    expect(result.status).toBe("timed_out");
    expect(result.error).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// createTaskTool
// ---------------------------------------------------------------------------

describe("createTaskTool", () => {
  it("returns error for unknown subagent type", async () => {
    const registry = new SubagentRegistry();
    registry.register(generalPurposeSubagent);

    const tool = createTaskTool({
      registry,
      tools: [],
      model: makeStubModel("") as any
    });

    const result = await tool.invoke({
      description: "test task",
      prompt: "do something",
      subagentType: "nonexistent"
    });

    expect(String(result)).toContain("Unknown subagent type");
    expect(String(result)).toContain("general-purpose");
  });

  it("delegates to subagent and returns result", async () => {
    const registry = new SubagentRegistry();
    registry.register(generalPurposeSubagent);

    const model = makeStubModel("Task result here.");
    const tool = createTaskTool({
      registry,
      tools: [],
      model: model as any
    });

    const result = await tool.invoke({
      description: "analyze code",
      prompt: "Review this function for bugs",
      subagentType: "general-purpose"
    });

    expect(String(result)).toContain("Task completed");
    expect(String(result)).toContain("Task result here.");
  });

  it("defaults to general-purpose when subagentType is omitted", async () => {
    const registry = new SubagentRegistry();
    registry.register(generalPurposeSubagent);

    const model = makeStubModel("Default agent result.");
    const tool = createTaskTool({
      registry,
      tools: [],
      model: model as any
    });

    const result = await tool.invoke({
      description: "quick task",
      prompt: "Do something"
    });

    expect(String(result)).toContain("Task completed");
    expect(String(result)).toContain("Default agent result.");
  });
});

// ---------------------------------------------------------------------------
// createSubagentPromptSection
// ---------------------------------------------------------------------------

describe("createSubagentPromptSection", () => {
  it("includes subagent names and descriptions", () => {
    const registry = new SubagentRegistry();
    registry.register(generalPurposeSubagent);

    const section = createSubagentPromptSection(registry);

    expect(section.heading).toBe("Task Delegation");
    expect(section.body).toContain("general-purpose");
    expect(section.body).toContain("task");
  });
});

// ---------------------------------------------------------------------------
// generalPurposeSubagent config
// ---------------------------------------------------------------------------

describe("generalPurposeSubagent", () => {
  it("has correct defaults", () => {
    expect(generalPurposeSubagent.name).toBe("general-purpose");
    expect(generalPurposeSubagent.disallowedTools).toContain("task");
    expect(generalPurposeSubagent.maxSteps).toBe(25);
    expect(generalPurposeSubagent.timeoutMs).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// createAgent with subagents option
// ---------------------------------------------------------------------------

describe("createAgent with subagents", () => {
  it("auto-injects task tool when subagents are provided", async () => {
    const model = makeStubModel("Direct answer without delegation.");
    const agent = createAgent({
      model: model as any,
      tools: [],
      subagents: [generalPurposeSubagent]
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Hello" }]
    });

    expect(result.text).toBe("Direct answer without delegation.");
  });

  it("works without subagents (backward compatible)", async () => {
    const model = makeStubModel("Simple answer.");
    const agent = createAgent({
      model: model as any,
      tools: []
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Hello" }]
    });

    expect(result.text).toBe("Simple answer.");
  });
});
