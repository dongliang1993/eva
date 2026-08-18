import { describe, expect, it } from "vitest";

import { RunRegistry } from "../apps/server/src/services/run-registry.js";

describe("RunRegistry", () => {
  it("register returns a live AbortController", () => {
    const registry = new RunRegistry();
    const controller = registry.register("run-1");

    expect(controller.signal.aborted).toBe(false);
  });

  it("abort trips the registered controller", () => {
    const registry = new RunRegistry();
    const controller = registry.register("run-1");

    expect(registry.abort("run-1")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("abort returns false for unknown or finished runs", () => {
    const registry = new RunRegistry();

    expect(registry.abort("missing")).toBe(false);
  });

  it("unregister removes the run so later abort is a no-op", () => {
    const registry = new RunRegistry();
    const controller = registry.register("run-1");

    registry.unregister("run-1");

    expect(registry.abort("run-1")).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("re-registering the same id replaces the previous controller", () => {
    const registry = new RunRegistry();
    const first = registry.register("run-1");
    const second = registry.register("run-1");

    registry.abort("run-1");

    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
  });
});
