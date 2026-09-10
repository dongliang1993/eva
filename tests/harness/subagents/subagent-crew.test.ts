import { describe, expect, it } from "vitest";

import {
  SUBAGENT_ROLES,
  filterToolsForRole,
  missingRoleTools,
} from "../../../packages/harness/src/subagents/crew.js";
import type { SubagentRole } from "../../../packages/harness/src/subagents/crew.js";
import type { AgentTool } from "../../../packages/harness/src/tools/build-tool.js";

// a stub AgentTool
const stubTool = (name: string): AgentTool =>
  ({ name, tool: {} as never }) as unknown as AgentTool;

const ALL_TOOLS = [
  "read_file", "list_dir", "grep", "read_skill",
  "write", "edit", "bash",
  "web_search", "web_fetch",
  "report"
].map(stubTool);

describe("filterToolsForRole (阀4: 工具集收窄)", () => {
  const role = (type: string): SubagentRole =>
    SUBAGENT_ROLES.find(role => role.type === type)!;

  it("explorer 拿不到 write/edit/bash", () => {
    const filtered = filterToolsForRole(ALL_TOOLS, role("explorer"));
    const names = filtered.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("grep");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("bash");
  });

  it("reviewer 也拿不到写工具", () => {
    const filtered = filterToolsForRole(ALL_TOOLS, role("reviewer"));
    const names = filtered.map((t) => t.name);
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("bash");
  });

  // 会话没绑工作区时,基础集里压根没有文件工具(它们挂在 workspace 守卫内)。
  // 过滤只会静默留下 read_skill —— 子代理于是"没有手却被要求读代码",
  // 实测会编造目录树。所以要能判定角色的核心工具是否缺席。
  it("基础集缺文件工具时 → explorer 只剩 read_skill(必须可判定,不能静默)", () => {
    const withoutFsTools = ["read_skill", "web_search"].map(stubTool);
    const filtered = filterToolsForRole(withoutFsTools, role("explorer"));

    expect(filtered.map((t) => t.name)).toEqual(["read_skill"]);
    expect(missingRoleTools(withoutFsTools, role("explorer"))).toEqual([
      "read_file", "list_dir", "grep"
    ]);
  });

  it("基础集齐全时 → 无缺席工具", () => {
    expect(missingRoleTools(ALL_TOOLS, role("explorer"))).toEqual([]);
  });
});
