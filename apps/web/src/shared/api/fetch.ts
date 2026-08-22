/**
 * Wrapped fetch that throws on non-2xx responses.
 * Native fetch only rejects on network errors, not HTTP errors.
 * This is required for @tanstack/react-query to properly detect errors.
 */
import { withLoopbackToken } from "./auth";

export async function apiFetch<T>(
  url: string,
  options?: RequestInit
): Promise<T> {
  // 只有真带 body 才声明 application/json。空 body + json 会导致 Fastify 在进
  // handler 前就拒掉(FST_ERR_CTP_EMPTY_JSON_BODY),POST 但无 body 的调用(如
  // switch-version)不需要这个头。
  const hasBody = options?.body !== undefined && options.body !== null;
  const response = await fetch(url, {
    headers: await withLoopbackToken({
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(options?.headers as Record<string, string> | undefined)
    }),
    ...options
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(response.status, body || response.statusText);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();

  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = "ApiError";
  }
}
