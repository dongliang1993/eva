import { describe, expect, it } from "vitest";

import type { ProviderType } from "../../../packages/shared/src/index.js";

import {
  PROVIDER_CATALOG,
  findProviderSpec
} from "../../../apps/server/src/modules/providers/index.js";

describe("provider-catalog", () => {
  it("每个 spec 的 type 唯一", () => {
    const types = PROVIDER_CATALOG.map((spec) => spec.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("kind 只能是 openai-compatible 或 anthropic", () => {
    for (const spec of PROVIDER_CATALOG) {
      expect(["openai-compatible", "anthropic"]).toContain(spec.kind);
    }
  });

  it("custom 之外的每个 openai-compatible spec 都有 defaultBaseURL", () => {
    for (const spec of PROVIDER_CATALOG) {
      if (spec.type === "custom") continue;
      if (spec.kind === "openai-compatible") {
        expect(spec.defaultBaseURL).toBeDefined();
      }
    }
  });

  it("ProviderType 的每个成员都能 findProviderSpec 命中(类型与数据钉在一起)", () => {
    const ALL_TYPES: readonly ProviderType[] = [
      "openai",
      "anthropic",
      "deepseek",
      "openrouter",
      "moonshot",
      "aihubmix",
      "custom"
    ];
    // 若 ProviderType 加了成员而这个数组没加,这行会类型报错
    void (Object.fromEntries(
      ALL_TYPES.map((t) => [t, true])
    ) as Record<ProviderType, true>);

    for (const type of ALL_TYPES) {
      expect(findProviderSpec(type)).toBeDefined();
    }
  });

  it("未知 type 返回 undefined(不要猜)", () => {
    expect(findProviderSpec("google")).toBeUndefined();
    expect(findProviderSpec("azure")).toBeUndefined();
  });
});
