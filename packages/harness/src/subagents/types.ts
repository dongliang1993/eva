export interface SubagentConfig {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly tools?: readonly string[] | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
  readonly maxSteps?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface SubagentResult {
  readonly text: string;
  readonly status: "completed" | "failed" | "timed_out";
  readonly durationMs: number;
  readonly error?: string | undefined;
}
