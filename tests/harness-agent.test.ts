import { describe, expect, it } from "vitest";
import {
  AIMessage,
  AIMessageChunk,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "../apps/server/node_modules/@langchain/core/messages.js";
import type { StructuredToolInterface } from "../apps/server/node_modules/@langchain/core/tools.js";

import {
  createAgent,
  createTool,
  NormalizedModelError,
  type AgentModel,
  type AgentStreamEvent
} from "../packages/harness/src/index.js";

const issueAnalysisSchema = {
  type: "object",
  properties: {
    issueId: {
      type: "string"
    }
  },
  required: ["issueId"],
  additionalProperties: false
} as const;

class FakeAgentModel implements AgentModel {
  private readonly scriptedReplies: AIMessage[];
  public readonly invocations: BaseMessage[][] = [];

  constructor(scriptedReplies: AIMessage[]) {
    this.scriptedReplies = scriptedReplies;
  }

  async invoke(
    messages: BaseMessage[],
    _tools: StructuredToolInterface[]
  ): Promise<AIMessage> {
    this.invocations.push(messages);
    const nextReply = this.scriptedReplies.shift();

    if (!nextReply) {
      throw new Error("No scripted reply available for FakeAgentModel.");
    }

    return nextReply;
  }

  async *stream(
    messages: BaseMessage[],
    _tools: StructuredToolInterface[]
  ): AsyncIterable<AIMessageChunk> {
    this.invocations.push(messages);
    const nextReply = this.scriptedReplies.shift();

    if (!nextReply) {
      throw new Error("No scripted reply available for FakeAgentModel.");
    }

    const content = typeof nextReply.content === "string" ? nextReply.content : "";
    const responseMetadata =
      nextReply.response_metadata as Record<string, unknown> | undefined;

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

    if (responseMetadata) {
      yield new AIMessageChunk({
        content: "",
        response_metadata: responseMetadata
      });
    }
  }
}

class ReactiveCompactTestModel implements AgentModel {
  public readonly invocations: BaseMessage[][] = [];
  private readonly finalText: string;

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
        tool_call_chunks: reply.tool_calls.map((toolCall) => ({
          name: toolCall.name,
          args: JSON.stringify(toolCall.args),
          id: toolCall.id,
          index: 0
        }))
      });
    }
  }

  private buildReply(messages: BaseMessage[]): AIMessage {
    const callCount = this.invocations.length;
    const hasRuntimeSummary = messages.some(
      (message) =>
        message instanceof SystemMessage
        && String(message.content).includes("Runtime summary:")
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

const collectStream = async (
  iterable: AsyncIterable<AgentStreamEvent>
): Promise<AgentStreamEvent[]> => {
  const events: AgentStreamEvent[] = [];

  for await (const event of iterable) {
    events.push(event);
  }

  return events;
};

describe("createAgent", () => {
  it("returns the model answer directly when no tool call is needed", async () => {
    const model = new FakeAgentModel([
      new AIMessage({
        content: "Direct answer"
      })
    ]);
    const agent = createAgent({
      model
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: "Say hello"
        }
      ]
    });

    expect(result).toEqual({
      text: "Direct answer",
      toolCalls: []
    });
    expect(model.invocations).toHaveLength(1);
  });

  it("executes a tool call and returns the follow-up model answer", async () => {
    const model = new FakeAgentModel([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "issue_analysis",
            args: {
              issueId: "123"
            },
            id: "tool-1"
          }
        ]
      }),
      new AIMessage({
        content: "Issue 123 points to the controller null-check path."
      })
    ]);
    const issueAnalysisTool = createTool(
      async ({ issueId }: { issueId: string }) =>
        `Issue ${issueId} points to src/controller.ts:42`,
      {
        name: "issue_analysis",
        description: "Analyze a Sentry issue by ID.",
        schema: issueAnalysisSchema
      }
    );
    const agent = createAgent({
      model,
      tools: [issueAnalysisTool]
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: "Analyze issue 123"
        }
      ]
    });

    expect(result).toEqual({
      text: "Issue 123 points to the controller null-check path.",
      toolCalls: [
        expect.objectContaining({
          toolName: "issue_analysis",
          toolCallId: "tool-1",
          args: {
            issueId: "123"
          },
          output: "Issue 123 points to src/controller.ts:42",
          status: "success"
        })
      ]
    });
    expect(model.invocations).toHaveLength(2);
    expect(
      model.invocations[1]?.some(
        (message) =>
          message instanceof ToolMessage &&
          message.tool_call_id === "tool-1" &&
          String(message.content) === "Issue 123 points to src/controller.ts:42"
      )
    ).toBe(true);
  });

  it("records tool failures and lets the model continue", async () => {
    const model = new FakeAgentModel([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "issue_analysis",
            args: {
              issueId: "123"
            },
            id: "tool-err"
          }
        ]
      }),
      new AIMessage({
        content: "The issue lookup failed because the tool raised an error."
      })
    ]);
    const failingTool = createTool(
      async () => {
        throw new Error("Sentry is unavailable");
      },
      {
        name: "issue_analysis",
        description: "Analyze a Sentry issue by ID.",
        schema: issueAnalysisSchema
      }
    );
    const agent = createAgent({
      model,
      tools: [failingTool]
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: "Analyze issue 123"
        }
      ]
    });

    expect(result).toEqual({
      text: "The issue lookup failed because the tool raised an error.",
      toolCalls: [
        expect.objectContaining({
          toolName: "issue_analysis",
          toolCallId: "tool-err",
          args: {
            issueId: "123"
          },
          output: "Sentry is unavailable",
          status: "error"
        })
      ]
    });
  });

  it("trims older tool results before a later model step while preserving the latest trajectory", async () => {
    const hugeOutput = "A".repeat(6_000);
    const model = new FakeAgentModel([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "first_tool",
            args: { issueId: "123" },
            id: "tc-1"
          }
        ]
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "second_tool",
            args: { issueId: "456" },
            id: "tc-2"
          }
        ]
      }),
      new AIMessage({
        content: "Final answer"
      })
    ]);
    const firstTool = createTool(
      async () => hugeOutput,
      {
        name: "first_tool",
        description: "Returns a large tool result.",
        schema: issueAnalysisSchema
      }
    );
    const secondTool = createTool(
      async () => "small result",
      {
        name: "second_tool",
        description: "Returns a small tool result.",
        schema: issueAnalysisSchema
      }
    );
    const agent = createAgent({
      model,
      tools: [firstTool, secondTool],
      contextPolicy: {
        toolResultBudgetTokens: 200
      }
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: "Analyze two related issues"
        }
      ]
    });

    expect(result.text).toBe("Final answer");
    expect(model.invocations).toHaveLength(3);

    const secondStepMessages = model.invocations[1] ?? [];
    expect(
      secondStepMessages.some(
        (message) =>
          message instanceof ToolMessage
          && message.tool_call_id === "tc-1"
          && String(message.content) === hugeOutput
      )
    ).toBe(true);

    const thirdStepMessages = model.invocations[2] ?? [];
    const firstToolMessage = thirdStepMessages.find(
      (message) =>
        message instanceof ToolMessage && message.tool_call_id === "tc-1"
    );
    const secondToolMessage = thirdStepMessages.find(
      (message) =>
        message instanceof ToolMessage && message.tool_call_id === "tc-2"
    );

    expect(String(firstToolMessage?.content)).toContain(
      "Tool result omitted due to context budget."
    );
    expect(String(firstToolMessage?.content)).toContain("Tool: first_tool");
    expect(String(secondToolMessage?.content)).toBe("small result");
  });

  it("proactively compacts older runtime steps into a summary before the next model call", async () => {
    const toolOutput = "context ".repeat(220).trim();
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
      new AIMessage({
        content: "Final answer after compaction"
      })
    ]);
    const tools = ["first_tool", "second_tool", "third_tool"].map((name) =>
      createTool(
        async () => `${name}: ${toolOutput}`,
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
      contextPolicy: {
        contextWindow: 1_200,
        reservedOutputTokens: 200,
        loopCompactBufferTokens: 150,
        toolResultBudgetTokens: 10_000
      }
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Need three analysis passes" }]
    });

    expect(result.text).toBe("Final answer after compaction");
    expect(model.invocations).toHaveLength(4);

    const finalStepMessages = model.invocations[3] ?? [];
    const runtimeSummary = finalStepMessages[2];

    expect(runtimeSummary).toBeInstanceOf(SystemMessage);
    expect(String(runtimeSummary?.content)).toContain("Runtime summary:");
    expect(String(runtimeSummary?.content)).toContain("first_tool");

    expect(
      finalStepMessages.some(
        (message) =>
          message instanceof ToolMessage && message.tool_call_id === "tc-1"
      )
    ).toBe(false);
    expect(
      finalStepMessages.some(
        (message) =>
          message instanceof ToolMessage
          && message.tool_call_id === "tc-3"
          && String(message.content).includes("third_tool:")
      )
    ).toBe(true);
  });

  it("reactively compacts and retries once when the model reports prompt overflow", async () => {
    const toolOutput = "overflow context ".repeat(180).trim();
    const model = new ReactiveCompactTestModel("Recovered final answer");
    const tools = ["first_tool", "second_tool"].map((name) =>
      createTool(
        async () => `${name}: ${toolOutput}`,
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
      contextPolicy: {
        contextWindow: 100_000,
        reservedOutputTokens: 1_000,
        loopCompactBufferTokens: 0,
        toolResultBudgetTokens: 10_000
      }
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Force a reactive compact" }]
    });

    expect(result.text).toBe("Recovered final answer");
    expect(model.invocations).toHaveLength(4);

    const retryMessages = model.invocations[3] ?? [];
    expect(
      retryMessages.some(
        (message) =>
          message instanceof SystemMessage
          && String(message.content).includes("Runtime summary:")
      )
    ).toBe(true);
    expect(
      retryMessages.some(
        (message) =>
          message instanceof ToolMessage && message.tool_call_id === "tc-1"
      )
    ).toBe(false);
  });

  it("continues automatically when the model stops due to output length", async () => {
    const model = new FakeAgentModel([
      new AIMessage({
        content: "Partial ",
        response_metadata: {
          finish_reason: "length"
        }
      }),
      new AIMessage({
        content: "answer."
      })
    ]);
    const agent = createAgent({
      model,
      maxSteps: 4
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Give a long answer" }]
    });

    expect(result).toEqual({
      text: "Partial answer.",
      toolCalls: []
    });
    expect(model.invocations).toHaveLength(2);
  });
});

describe("createAgent stream", () => {
  it("yields text chunks and a result event for a direct answer", async () => {
    const model = new FakeAgentModel([
      new AIMessage({ content: "Hi" })
    ]);
    const agent = createAgent({ model });

    const events = await collectStream(
      agent.stream({
        messages: [{ role: "user", content: "Say hello" }]
      })
    );

    const textChunks = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: "text_chunk" }> =>
        e.type === "text_chunk"
    );
    expect(textChunks.map((c) => c.content).join("")).toBe("Hi");

    const resultEvent = events.find((e) => e.type === "result");
    expect(resultEvent).toEqual({
      type: "result",
      text: "Hi",
      toolCalls: []
    });
  });

  it("yields tool_call_start, tool_call_end, then text and result", async () => {
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
    const agent = createAgent({ model, tools: [tool] });

    const events = await collectStream(
      agent.stream({
        messages: [{ role: "user", content: "Analyze 42" }]
      })
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_end");
    expect(types).toContain("result");

    const startEvent = events.find((e) => e.type === "tool_call_start");
    expect(startEvent).toEqual({
      type: "tool_call_start",
      toolName: "issue_analysis",
      toolCallId: "tc-1",
      args: { issueId: "42" }
    });

    const endEvent = events.find((e) => e.type === "tool_call_end");
    expect(endEvent).toEqual({
      type: "tool_call_end",
      toolName: "issue_analysis",
      toolCallId: "tc-1",
      output: "Result for 42",
      status: "success"
    });

    const resultEvent = events.find((e) => e.type === "result") as Extract<
      AgentStreamEvent,
      { type: "result" }
    >;
    expect(resultEvent.text).toBe("Done");
    expect(resultEvent.toolCalls).toHaveLength(1);
  });

  it("yields an error event when the model throws", async () => {
    const model = new FakeAgentModel([]);
    const agent = createAgent({ model });

    const events = await collectStream(
      agent.stream({
        messages: [{ role: "user", content: "Boom" }]
      })
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  it("applies tool result budget in stream mode without trimming the latest tool output", async () => {
    const hugeOutput = "B".repeat(6_000);
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
      new AIMessage({ content: "Done" })
    ]);
    const firstTool = createTool(
      async () => hugeOutput,
      {
        name: "first_tool",
        description: "Returns a large tool result.",
        schema: issueAnalysisSchema
      }
    );
    const secondTool = createTool(
      async () => "recent result",
      {
        name: "second_tool",
        description: "Returns a small tool result.",
        schema: issueAnalysisSchema
      }
    );
    const agent = createAgent({
      model,
      tools: [firstTool, secondTool],
      contextPolicy: {
        toolResultBudgetTokens: 200
      }
    });

    const events = await collectStream(
      agent.stream({
        messages: [{ role: "user", content: "Analyze and continue" }]
      })
    );

    expect(events.find((event) => event.type === "result")).toEqual({
      type: "result",
      text: "Done",
      toolCalls: expect.any(Array)
    });

    const thirdStepMessages = model.invocations[2] ?? [];
    const firstToolMessage = thirdStepMessages.find(
      (message) =>
        message instanceof ToolMessage && message.tool_call_id === "tc-1"
    );
    const secondToolMessage = thirdStepMessages.find(
      (message) =>
        message instanceof ToolMessage && message.tool_call_id === "tc-2"
    );

    expect(String(firstToolMessage?.content)).toContain(
      "Tool result omitted due to context budget."
    );
    expect(String(secondToolMessage?.content)).toBe("recent result");
  });

  it("proactively compacts older runtime steps in stream mode", async () => {
    const toolOutput = "stream context ".repeat(220).trim();
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
      new AIMessage({ content: "Done after stream compaction" })
    ]);
    const tools = ["first_tool", "second_tool", "third_tool"].map((name) =>
      createTool(
        async () => `${name}: ${toolOutput}`,
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
      contextPolicy: {
        contextWindow: 1_200,
        reservedOutputTokens: 200,
        loopCompactBufferTokens: 150,
        toolResultBudgetTokens: 10_000
      }
    });

    const events = await collectStream(
      agent.stream({
        messages: [{ role: "user", content: "Need streamed compaction" }]
      })
    );

    expect(events.find((event) => event.type === "result")).toEqual({
      type: "result",
      text: "Done after stream compaction",
      toolCalls: expect.any(Array)
    });

    const finalStepMessages = model.invocations[3] ?? [];
    const runtimeSummary = finalStepMessages[2];

    expect(runtimeSummary).toBeInstanceOf(SystemMessage);
    expect(String(runtimeSummary?.content)).toContain("Runtime summary:");
    expect(String(runtimeSummary?.content)).toContain("first_tool");
    expect(
      finalStepMessages.some(
        (message) =>
          message instanceof ToolMessage && message.tool_call_id === "tc-1"
      )
    ).toBe(false);
  });

  it("reactively compacts and retries once in stream mode", async () => {
    const toolOutput = "stream overflow ".repeat(180).trim();
    const model = new ReactiveCompactTestModel("Recovered streamed answer");
    const tools = ["first_tool", "second_tool"].map((name) =>
      createTool(
        async () => `${name}: ${toolOutput}`,
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
      contextPolicy: {
        contextWindow: 100_000,
        reservedOutputTokens: 1_000,
        loopCompactBufferTokens: 0,
        toolResultBudgetTokens: 10_000
      }
    });

    const events = await collectStream(
      agent.stream({
        messages: [{ role: "user", content: "Force streamed reactive compact" }]
      })
    );

    expect(events.find((event) => event.type === "result")).toEqual({
      type: "result",
      text: "Recovered streamed answer",
      toolCalls: expect.any(Array)
    });
    expect(model.invocations).toHaveLength(4);

    const retryMessages = model.invocations[3] ?? [];
    expect(
      retryMessages.some(
        (message) =>
          message instanceof SystemMessage
          && String(message.content).includes("Runtime summary:")
      )
    ).toBe(true);
  });

  it("continues automatically in stream mode when the model stops due to output length", async () => {
    const model = new FakeAgentModel([
      new AIMessage({
        content: "Partial ",
        response_metadata: {
          finish_reason: "length"
        }
      }),
      new AIMessage({
        content: "answer."
      })
    ]);
    const agent = createAgent({ model, maxSteps: 4 });

    const events = await collectStream(
      agent.stream({
        messages: [{ role: "user", content: "Stream a long answer" }]
      })
    );

    const textChunks = events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "text_chunk" }> =>
          event.type === "text_chunk"
      )
      .map((event) => event.content)
      .join("");

    expect(textChunks).toBe("Partial answer.");
    expect(events.find((event) => event.type === "result")).toEqual({
      type: "result",
      text: "Partial answer.",
      toolCalls: []
    });
  });
});
