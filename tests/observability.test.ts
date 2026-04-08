import { describe, expect, it } from "vitest";
import {
  AIMessage,
  AIMessageChunk
} from "../apps/server/node_modules/@langchain/core/messages.js";
import type { StructuredToolInterface } from "../apps/server/node_modules/@langchain/core/tools.js";
import type { BaseMessage } from "../apps/server/node_modules/@langchain/core/messages.js";

import {
  createAgent,
  createTool,
  extractTokenUsage,
  extractFinishReason,
  isMaxOutputContinuationCandidate,
  addTokenUsage,
  NormalizedModelError,
  ZERO_TOKEN_USAGE,
  type AgentModel,
  type AgentStreamEvent,
  type AgentTelemetryEvent,
  type TokenUsage
} from "../packages/harness/src/index.js";

// ---------------------------------------------------------------------------
// extractTokenUsage
// ---------------------------------------------------------------------------

describe("extractTokenUsage", () => {
  it("extracts token usage from response_metadata", () => {
    const metadata = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150
      }
    };

    const result = extractTokenUsage(metadata);

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150
    });
  });

  it("returns undefined when metadata is undefined", () => {
    expect(extractTokenUsage(undefined)).toBeUndefined();
  });

  it("returns undefined when usage is missing", () => {
    expect(extractTokenUsage({})).toBeUndefined();
  });

  it("returns undefined when usage has wrong shape", () => {
    expect(extractTokenUsage({ usage: "not an object" })).toBeUndefined();
    expect(extractTokenUsage({ usage: null })).toBeUndefined();
    expect(extractTokenUsage({ usage: { foo: 1 } })).toBeUndefined();
  });

  it("defaults non-numeric values to 0", () => {
    const metadata = {
      usage: {
        prompt_tokens: "not a number",
        completion_tokens: undefined,
        total_tokens: 100
      }
    };

    const result = extractTokenUsage(metadata);

    expect(result).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 100
    });
  });
});

describe("finish reason helpers", () => {
  it("extracts finish reasons from response metadata", () => {
    expect(extractFinishReason({ finish_reason: "length" })).toBe("length");
    expect(extractFinishReason({ finishReason: "stop" })).toBe("stop");
    expect(extractFinishReason({ stop_reason: "max_tokens" })).toBe("max_tokens");
  });

  it("detects max-output continuation candidates", () => {
    expect(isMaxOutputContinuationCandidate({ finish_reason: "length" })).toBe(true);
    expect(isMaxOutputContinuationCandidate({ stop_reason: "max_tokens" })).toBe(true);
    expect(isMaxOutputContinuationCandidate({ finishReason: "stop" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addTokenUsage
// ---------------------------------------------------------------------------

describe("addTokenUsage", () => {
  it("adds two token usages immutably", () => {
    const a: TokenUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
    const b: TokenUsage = { promptTokens: 200, completionTokens: 30, totalTokens: 230 };

    const result = addTokenUsage(a, b);

    expect(result).toEqual({
      promptTokens: 300,
      completionTokens: 80,
      totalTokens: 380
    });
    // Originals unchanged
    expect(a.promptTokens).toBe(100);
    expect(b.promptTokens).toBe(200);
  });

  it("adding ZERO_TOKEN_USAGE is identity", () => {
    const a: TokenUsage = { promptTokens: 42, completionTokens: 7, totalTokens: 49 };

    expect(addTokenUsage(a, ZERO_TOKEN_USAGE)).toEqual(a);
    expect(addTokenUsage(ZERO_TOKEN_USAGE, a)).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// FakeAgentModel — scripted model for observer tests
// ---------------------------------------------------------------------------

class FakeAgentModel implements AgentModel {
  private readonly scriptedReplies: AIMessage[];

  constructor(scriptedReplies: AIMessage[]) {
    this.scriptedReplies = scriptedReplies;
  }

  async invoke(
    _messages: BaseMessage[],
    _tools: StructuredToolInterface[]
  ): Promise<AIMessage> {
    const nextReply = this.scriptedReplies.shift();

    if (!nextReply) {
      throw new Error("No scripted reply available.");
    }

    return nextReply;
  }

  async *stream(
    _messages: BaseMessage[],
    _tools: StructuredToolInterface[]
  ): AsyncIterable<AIMessageChunk> {
    const nextReply = this.scriptedReplies.shift();

    if (!nextReply) {
      throw new Error("No scripted reply available.");
    }

    const content = typeof nextReply.content === "string" ? nextReply.content : "";

    if (content) {
      for (const char of content) {
        yield new AIMessageChunk({ content: char });
      }
    }

    if (nextReply.tool_calls && nextReply.tool_calls.length > 0) {
      yield new AIMessageChunk({
        content: "",
        tool_calls: nextReply.tool_calls,
        tool_call_chunks: nextReply.tool_calls.map((tc) => ({
          name: tc.name,
          args: JSON.stringify(tc.args),
          id: tc.id,
          index: 0
        }))
      });
    }
  }
}

class ReactiveCompactObserverModel implements AgentModel {
  private readonly finalText: string;
  public readonly invocations: BaseMessage[][] = [];

  constructor(finalText: string) {
    this.finalText = finalText;
  }

  async invoke(
    messages: BaseMessage[],
    _tools: StructuredToolInterface[]
  ): Promise<AIMessage> {
    this.invocations.push(messages);
    return this.buildReply(messages);
  }

  async *stream(
    messages: BaseMessage[],
    _tools: StructuredToolInterface[]
  ): AsyncIterable<AIMessageChunk> {
    this.invocations.push(messages);
    const reply = this.buildReply(messages);
    const content = typeof reply.content === "string" ? reply.content : "";

    if (content) {
      for (const char of content) {
        yield new AIMessageChunk({ content: char });
      }
      return;
    }

    if (reply.tool_calls && reply.tool_calls.length > 0) {
      yield new AIMessageChunk({
        content: "",
        tool_calls: reply.tool_calls,
        tool_call_chunks: reply.tool_calls.map((toolCall, index) => ({
          name: toolCall.name,
          args: JSON.stringify(toolCall.args),
          id: toolCall.id,
          index
        }))
      });
    }
  }

  private buildReply(messages: BaseMessage[]): AIMessage {
    const callCount = this.invocations.length;
    const hasRuntimeSummary = messages.some((message) =>
      String(message.content).includes("Runtime summary:")
    );

    if (callCount === 1) {
      return new AIMessage({
        content: "",
        tool_calls: [
          { name: "first_tool", args: { issueId: "1" }, id: "tc-1" }
        ]
      });
    }

    if (callCount === 2) {
      return new AIMessage({
        content: "",
        tool_calls: [
          { name: "second_tool", args: { issueId: "2" }, id: "tc-2" }
        ]
      });
    }

    if (!hasRuntimeSummary) {
      throw new NormalizedModelError(
        "prompt_too_long",
        "Prompt too long for current context.",
        { retryable: true }
      );
    }

    return new AIMessage({ content: this.finalText });
  }
}

const issueAnalysisSchema = {
  type: "object",
  properties: { issueId: { type: "string" } },
  required: ["issueId"],
  additionalProperties: false
} as const;

const collectStream = async (
  iterable: AsyncIterable<AgentStreamEvent>
): Promise<AgentStreamEvent[]> => {
  const events: AgentStreamEvent[] = [];

  for await (const event of iterable) {
    events.push(event);
  }

  return events;
};

// ---------------------------------------------------------------------------
// Observer events via invoke()
// ---------------------------------------------------------------------------

describe("observer events via invoke", () => {
  it("emits correct event sequence for a direct answer", async () => {
    const observed: AgentTelemetryEvent[] = [];
    const observer = (event: AgentTelemetryEvent): void => {
      observed.push(event);
    };
    const model = new FakeAgentModel([
      new AIMessage({ content: "Hello" })
    ]);
    const agent = createAgent({ model, observer });

    await agent.invoke({ messages: [{ role: "user", content: "Hi" }] });

    const types = observed.map((e) => e.type);
    expect(types).toEqual([
      "agent_run_start",
      "llm_call_start",
      "llm_call_end",
      "agent_run_end"
    ]);

    const endEvent = observed.find(
      (e): e is Extract<AgentTelemetryEvent, { type: "agent_run_end" }> =>
        e.type === "agent_run_end"
    );
    expect(endEvent).toBeDefined();
    expect(endEvent!.stepCount).toBe(1);
    expect(endEvent!.toolCallCount).toBe(0);
    expect(endEvent!.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits tool_call events for tool invocations", async () => {
    const observed: AgentTelemetryEvent[] = [];
    const observer = (event: AgentTelemetryEvent): void => {
      observed.push(event);
    };
    const model = new FakeAgentModel([
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "issue_analysis", args: { issueId: "42" }, id: "tc-1" }
        ]
      }),
      new AIMessage({ content: "Done" })
    ]);
    const tool = createTool(
      async ({ issueId }: { issueId: string }) => `Result for ${issueId}`,
      {
        name: "issue_analysis",
        description: "Analyze",
        schema: issueAnalysisSchema
      }
    );
    const agent = createAgent({ model, tools: [tool], observer });

    await agent.invoke({
      messages: [{ role: "user", content: "Analyze 42" }]
    });

    const types = observed.map((e) => e.type);
    expect(types).toEqual([
      "agent_run_start",
      "llm_call_start",
      "llm_call_end",
      "tool_call_start",
      "tool_call_end",
      "loop_transition",
      "llm_call_start",
      "llm_call_end",
      "agent_run_end"
    ]);

    const toolStart = observed.find(
      (e): e is Extract<AgentTelemetryEvent, { type: "tool_call_start" }> =>
        e.type === "tool_call_start"
    );
    expect(toolStart!.toolName).toBe("issue_analysis");
    expect(toolStart!.toolCallId).toBe("tc-1");

    const toolEnd = observed.find(
      (e): e is Extract<AgentTelemetryEvent, { type: "tool_call_end" }> =>
        e.type === "tool_call_end"
    );
    expect(toolEnd!.status).toBe("success");
    expect(toolEnd!.durationMs).toBeGreaterThanOrEqual(0);

    const endEvent = observed.find(
      (e): e is Extract<AgentTelemetryEvent, { type: "agent_run_end" }> =>
        e.type === "agent_run_end"
    );
    expect(endEvent!.toolCallCount).toBe(1);
  });

  it("emits continuation transition events after max-output recovery", async () => {
    const observed: AgentTelemetryEvent[] = [];
    const observer = (event: AgentTelemetryEvent): void => {
      observed.push(event);
    };
    const model = new FakeAgentModel([
      new AIMessage({
        content: "Partial ",
        response_metadata: {
          finish_reason: "length"
        }
      }),
      new AIMessage({ content: "answer." })
    ]);
    const agent = createAgent({ model, observer, maxSteps: 4 });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Continue please" }]
    });

    expect(result.text).toBe("Partial answer.");

    const transitionEvent = observed.find(
      (event): event is Extract<AgentTelemetryEvent, { type: "loop_transition" }> =>
        event.type === "loop_transition"
        && event.reason === "max_output_tokens_recovery"
    );

    expect(transitionEvent).toBeDefined();
    expect(transitionEvent?.attempt).toBe(1);
  });

  it("emits proactive compaction telemetry when runtime context is compacted", async () => {
    const observed: AgentTelemetryEvent[] = [];
    const observer = (event: AgentTelemetryEvent): void => {
      observed.push(event);
    };
    const model = new FakeAgentModel([
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "first_tool", args: { issueId: "1" }, id: "tc-1" }
        ]
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "second_tool", args: { issueId: "2" }, id: "tc-2" }
        ]
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "third_tool", args: { issueId: "3" }, id: "tc-3" }
        ]
      }),
      new AIMessage({ content: "Done" })
    ]);
    const largeOutput = "runtime context ".repeat(220).trim();
    const tools = ["first_tool", "second_tool", "third_tool"].map((name) =>
      createTool(
        async () => `${name}: ${largeOutput}`,
        {
          name,
          description: `${name} description`,
          schema: issueAnalysisSchema
        }
      )
    );
    const agent = createAgent({
      model,
      tools,
      observer,
      contextPolicy: {
        contextWindow: 1_200,
        reservedOutputTokens: 200,
        loopCompactBufferTokens: 150,
        toolResultBudgetTokens: 10_000
      }
    });

    await agent.invoke({
      messages: [{ role: "user", content: "Need compaction telemetry" }]
    });

    const compactionEvent = observed.find(
      (event): event is Extract<AgentTelemetryEvent, { type: "context_compacted" }> =>
        event.type === "context_compacted"
        && event.reason === "proactive_loop_compact"
    );

    expect(compactionEvent).toBeDefined();
    expect(compactionEvent!.messageCountBefore).toBeGreaterThan(
      compactionEvent!.messageCountAfter
    );
    expect(compactionEvent!.estimatedTokensBefore).toBeGreaterThan(
      compactionEvent!.estimatedTokensAfter
    );

    expect(
      observed.some(
        (event) =>
          event.type === "loop_transition"
          && event.reason === "proactive_loop_compact"
      )
    ).toBe(true);
  });

  it("emits reactive compaction telemetry when retrying after overflow", async () => {
    const observed: AgentTelemetryEvent[] = [];
    const observer = (event: AgentTelemetryEvent): void => {
      observed.push(event);
    };
    const model = new ReactiveCompactObserverModel("Recovered");
    const tools = ["first_tool", "second_tool"].map((name) =>
      createTool(
        async ({ issueId }: { issueId: string }) => `${name}:${issueId}`,
        {
          name,
          description: `${name} description`,
          schema: issueAnalysisSchema
        }
      )
    );
    const agent = createAgent({
      model,
      tools,
      observer,
      contextPolicy: {
        contextWindow: 100_000,
        reservedOutputTokens: 1_000,
        loopCompactBufferTokens: 0,
        toolResultBudgetTokens: 10_000
      }
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Recover from overflow" }]
    });

    expect(result.text).toBe("Recovered");

    const compactionEvent = observed.find(
      (event): event is Extract<AgentTelemetryEvent, { type: "context_compacted" }> =>
        event.type === "context_compacted"
        && event.reason === "reactive_compact_retry"
    );

    expect(compactionEvent).toBeDefined();
    expect(compactionEvent!.messageCountBefore).toBeGreaterThan(
      compactionEvent!.messageCountAfter
    );
    expect(
      observed.some(
        (event) =>
          event.type === "loop_transition"
          && event.reason === "reactive_compact_retry"
      )
    ).toBe(true);
  });

  it("does not break when observer throws", async () => {
    const throwingObserver = (): void => {
      throw new Error("Observer kaboom");
    };
    const model = new FakeAgentModel([
      new AIMessage({ content: "Hello" })
    ]);
    const agent = createAgent({ model, observer: throwingObserver });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Hi" }]
    });

    expect(result.text).toBe("Hello");
  });

  it("works normally without an observer (regression)", async () => {
    const model = new FakeAgentModel([
      new AIMessage({ content: "Hello" })
    ]);
    const agent = createAgent({ model });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Hi" }]
    });

    expect(result.text).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// Observer events via stream()
// ---------------------------------------------------------------------------

describe("observer events via stream", () => {
  it("emits correct event sequence for a direct answer", async () => {
    const observed: AgentTelemetryEvent[] = [];
    const observer = (event: AgentTelemetryEvent): void => {
      observed.push(event);
    };
    const model = new FakeAgentModel([
      new AIMessage({ content: "Hi" })
    ]);
    const agent = createAgent({ model, observer });

    await collectStream(
      agent.stream({ messages: [{ role: "user", content: "Hello" }] })
    );

    const types = observed.map((e) => e.type);
    expect(types).toEqual([
      "agent_run_start",
      "llm_call_start",
      "llm_call_end",
      "agent_run_end"
    ]);
  });

  it("emits tool_call events in stream path", async () => {
    const observed: AgentTelemetryEvent[] = [];
    const observer = (event: AgentTelemetryEvent): void => {
      observed.push(event);
    };
    const model = new FakeAgentModel([
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "issue_analysis", args: { issueId: "99" }, id: "tc-2" }
        ]
      }),
      new AIMessage({ content: "Result" })
    ]);
    const tool = createTool(
      async ({ issueId }: { issueId: string }) => `Analyzed ${issueId}`,
      {
        name: "issue_analysis",
        description: "Analyze",
        schema: issueAnalysisSchema
      }
    );
    const agent = createAgent({ model, tools: [tool], observer });

    await collectStream(
      agent.stream({ messages: [{ role: "user", content: "Go" }] })
    );

    const types = observed.map((e) => e.type);
    expect(types).toEqual([
      "agent_run_start",
      "llm_call_start",
      "llm_call_end",
      "tool_call_start",
      "tool_call_end",
      "loop_transition",
      "llm_call_start",
      "llm_call_end",
      "agent_run_end"
    ]);
  });

  it("does not break stream when observer throws", async () => {
    const throwingObserver = (): void => {
      throw new Error("Observer kaboom");
    };
    const model = new FakeAgentModel([
      new AIMessage({ content: "Streamed" })
    ]);
    const agent = createAgent({ model, observer: throwingObserver });

    const events = await collectStream(
      agent.stream({ messages: [{ role: "user", content: "Go" }] })
    );

    const resultEvent = events.find((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
  });
});
