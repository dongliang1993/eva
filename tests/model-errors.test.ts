import { describe, expect, it } from "vitest";

import {
  isReactiveCompactCandidateError,
  normalizeModelError
} from "../packages/harness/src/index.js";

describe("normalizeModelError", () => {
  it("normalizes prompt-too-long style messages", () => {
    const error = normalizeModelError(new Error("Prompt is too long for this model."));

    expect(error.code).toBe("prompt_too_long");
    expect(error.retryable).toBe(true);
  });

  it("normalizes context window overflow codes", () => {
    const error = normalizeModelError({
      code: "context_length_exceeded",
      message: "This model's maximum context length is exceeded."
    });

    expect(error.code).toBe("context_window_exceeded");
    expect(error.retryable).toBe(true);
  });

  it("recognizes reactive compact candidate errors", () => {
    expect(
      isReactiveCompactCandidateError(
        new Error("Maximum context length exceeded.")
      )
    ).toBe(true);
    expect(
      isReactiveCompactCandidateError(
        new Error("Authentication failed.")
      )
    ).toBe(false);
  });
});
