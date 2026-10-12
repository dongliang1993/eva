import { describe, expect, it } from "vitest";

import { evaluatePermission } from "../../../packages/harness/src/query/permission.js";
import type { PermissionResult } from "../../../packages/harness/src/query/types.js";

const signal = new AbortController().signal;
const options = { signal, toolUseID: "tc-1" };

describe("evaluatePermission(FR-004 顺序)", () => {
  it("hook deny 优先于一切:不调 readOnlyHint 直放、不调 canUseTool", async () => {
    const canUseTool = async (): Promise<PermissionResult> => {
      throw new Error("canUseTool must not be called");
    };
    const result = await evaluatePermission({
      toolName: "read_file",
      toolInput: {},
      annotations: { readOnlyHint: true },
      canUseTool,
      hookDeny: { message: "blocked by policy" },
      options,
    });
    expect(result).toEqual({ behavior: "deny", message: "blocked by policy" });
  });

  it("readOnlyHint === true 直放:不调 canUseTool", async () => {
    const result = await evaluatePermission({
      toolName: "read_file",
      toolInput: {},
      annotations: { readOnlyHint: true },
      canUseTool: undefined,
      hookDeny: undefined,
      options,
    });
    expect(result).toEqual({ behavior: "allow" });
  });

  it("readOnlyHint !== true 时走 canUseTool;allow 带 updatedInput", async () => {
    const result = await evaluatePermission({
      toolName: "exit_plan_mode",
      toolInput: { plan: "x" },
      annotations: { readOnlyHint: false },
      canUseTool: async () => ({
        behavior: "allow",
        updatedInput: { plan: "x", decision: "approve" },
      }),
      hookDeny: undefined,
      options,
    });
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { plan: "x", decision: "approve" },
    });
  });

  it("canUseTool 返回 deny:原样透传 message/interrupt/isError", async () => {
    const result = await evaluatePermission({
      toolName: "write",
      toolInput: { path: "a" },
      annotations: undefined,
      canUseTool: async () => ({
        behavior: "deny",
        message: "[Plan Mode] …",
        interrupt: true,
        isError: true,
      }),
      hookDeny: undefined,
      options,
    });
    expect(result).toEqual({
      behavior: "deny",
      message: "[Plan Mode] …",
      interrupt: true,
      isError: true,
    });
  });

  it("未提供 canUseTool 且非只读 → deny(缺省拒绝,不隐式放行)", async () => {
    const result = await evaluatePermission({
      toolName: "bash",
      toolInput: { command: "ls" },
      annotations: undefined,
      canUseTool: undefined,
      hookDeny: undefined,
      options,
    });
    expect(result.behavior).toBe("deny");
    if (result.behavior !== "deny") throw new Error("unreachable");
    expect(result.message).toContain("denied");
  });

  it("canUseTool 抛错 → 往上抛(tool-call 兜底成失败结果)", async () => {
    await expect(evaluatePermission({
      toolName: "write",
      toolInput: {},
      annotations: undefined,
      canUseTool: async () => {
        throw new Error("gateway down");
      },
      hookDeny: undefined,
      options,
    })).rejects.toThrow("gateway down");
  });
});
