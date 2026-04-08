import { describe, expect, it, vi } from "vitest";

import { AgentUnavailableError } from "../apps/server/src/agent.js";
import { RunApiService } from "../apps/server/src/services/runs.js";


describe("RunApiService", () => {
  it("delegates wait requests to the main agent", async () => {
    const invoke = vi.fn().mockResolvedValue({
      text: "Issue 123 looks like a null-check regression.",
      toolCalls: []
    });
    const service = new RunApiService(
      () =>
        ({
          invoke
        } as never)
    );

    const result = await service.wait({
      messages: [
        {
          role: "user",
          content: "Analyze issue 123"
        }
      ],
      context: {
        source: "http"
      },
      maxSteps: 3
    });

    expect(invoke).toHaveBeenCalledWith({
      messages: [
        {
          role: "user",
          content: "Analyze issue 123"
        }
      ],
      context: {
        source: "http"
      },
      maxSteps: 3
    });
    expect(result).toEqual({
      text: "Issue 123 looks like a null-check regression.",
      toolCalls: []
    });
  });

  it("throws when the main agent is unavailable", async () => {
    const service = new RunApiService(undefined);

    expect(() =>
      service.wait({
        messages: [
          {
            role: "user",
            content: "Analyze issue 123"
          }
        ]
      })
    ).toThrow(AgentUnavailableError);
  });
});
