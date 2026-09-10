import path from "node:path";

// Shared by every run: two sessions editing the same workspace must also serialize.
const pending = new Map<string, Promise<void>>();

export async function withWorkspaceWrite<T>(
  root: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const key = path.resolve(root);
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, done);
  try {
    await previous;
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release();
    if (pending.get(key) === done) pending.delete(key);
  }
}
