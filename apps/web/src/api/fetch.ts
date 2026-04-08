/**
 * Wrapped fetch that throws on non-2xx responses.
 * Native fetch only rejects on network errors, not HTTP errors.
 * This is required for @tanstack/react-query to properly detect errors.
 */
export async function apiFetch<T>(
  url: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers
    },
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

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = "ApiError";
  }
}
