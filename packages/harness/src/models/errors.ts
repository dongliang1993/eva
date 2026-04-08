export type NormalizedModelErrorCode =
  | "prompt_too_long"
  | "context_window_exceeded"
  | "max_output_tokens"
  | "rate_limit"
  | "auth"
  | "unknown";

const matchMessage = (message: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(message));

const PROMPT_TOO_LONG_PATTERNS = [
  /prompt (is )?too long/i,
  /request too large/i,
  /too many input tokens/i,
  /input is too long/i,
  /maximum prompt length/i
] as const;

const CONTEXT_WINDOW_PATTERNS = [
  /context length/i,
  /maximum context length/i,
  /context window/i,
  /context[_ -]?length[_ -]?exceeded/i,
  /context overflow/i
] as const;

const MAX_OUTPUT_PATTERNS = [
  /max[_ -]?output[_ -]?tokens/i,
  /maximum output tokens/i,
  /output token limit/i,
  /finish reason.*length/i
] as const;

const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /too many requests/i
] as const;

const AUTH_PATTERNS = [
  /unauthorized/i,
  /authentication/i,
  /invalid api key/i,
  /forbidden/i
] as const;

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? "Unknown model error");

const readStringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }

  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
};

const readNumberField = (value: unknown, key: string): number | undefined => {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }

  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
};

export class NormalizedModelError extends Error {
  readonly code: NormalizedModelErrorCode;
  readonly retryable: boolean;
  readonly raw?: unknown;

  constructor(
    code: NormalizedModelErrorCode,
    message: string,
    options?: { retryable?: boolean; raw?: unknown }
  ) {
    super(message);
    this.name = "NormalizedModelError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.raw = options?.raw;
  }
}

export const normalizeModelError = (error: unknown): NormalizedModelError => {
  if (error instanceof NormalizedModelError) {
    return error;
  }

  const message = toErrorMessage(error);
  const lowerMessage = message.toLowerCase();
  const status = readNumberField(error, "status");
  const code =
    readStringField(error, "code")
    ?? readStringField(error, "type")
    ?? readStringField(
      typeof error === "object" && error !== null ? (error as Record<string, unknown>).error : undefined,
      "code"
    )
    ?? "";
  const lowerCode = code.toLowerCase();

  if (
    status === 413
    || matchMessage(lowerMessage, PROMPT_TOO_LONG_PATTERNS)
  ) {
    return new NormalizedModelError("prompt_too_long", message, {
      retryable: true,
      raw: error
    });
  }

  if (
    lowerCode.includes("context_length")
    || lowerCode.includes("context_window")
    || matchMessage(lowerMessage, CONTEXT_WINDOW_PATTERNS)
  ) {
    return new NormalizedModelError("context_window_exceeded", message, {
      retryable: true,
      raw: error
    });
  }

  if (matchMessage(lowerMessage, MAX_OUTPUT_PATTERNS)) {
    return new NormalizedModelError("max_output_tokens", message, {
      retryable: true,
      raw: error
    });
  }

  if (status === 429 || matchMessage(lowerMessage, RATE_LIMIT_PATTERNS)) {
    return new NormalizedModelError("rate_limit", message, {
      retryable: true,
      raw: error
    });
  }

  if (
    status === 401
    || status === 403
    || matchMessage(lowerMessage, AUTH_PATTERNS)
  ) {
    return new NormalizedModelError("auth", message, {
      raw: error
    });
  }

  return new NormalizedModelError("unknown", message, {
    raw: error
  });
};

export const isReactiveCompactCandidateError = (error: unknown): boolean => {
  const normalized = normalizeModelError(error);

  return (
    normalized.code === "prompt_too_long"
    || normalized.code === "context_window_exceeded"
  );
};
