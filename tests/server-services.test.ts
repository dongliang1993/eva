import { describe, expect, it, vi } from "vitest";

import { RunApiService } from "../apps/server/src/services/runs.js";


describe("RunApiService", () => {
  it("delegates wait requests to the agent", async () => {
    const invoke = vi.fn().mockResolvedValue({
      text: "Issue 123 looks like a null-check regression.",
      toolCalls: []
    });
    const service = new RunApiService({
      invoke
    } as never);

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
});
