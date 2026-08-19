import { describe, expect, it } from "vitest";

import {
  CrewRegistry,
  filterToolsForRole,
  missingRoleTools,
  canDelegate,
  canSpawnAtDepth,
  MAX_DEPTH
} from "../packages/harness/src/subagents/crew.js";
import type { SubagentRole } from "../packages/harness/src/subagents/types.js";
import type { AgentTool } from "../packages/harness/src/tools.js";

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
    new CrewRegistry().get(type)!;

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
      "read_file", "list_dir", "grep", "report"
    ]);
  });

  // S7 push:report 是子代理交付结论的唯一出口,三个角色都必须有,
  // 否则它干完活却没有任何通道把结果送回父级。
  it("三个内置角色都拿得到 report", () => {
    for (const type of ["explorer", "researcher", "reviewer"]) {
      const names = filterToolsForRole(ALL_TOOLS, role(type)).map((t) => t.name);
      expect(names).toContain("report");
    }
  });

  it("基础集齐全时 → 无缺席工具", () => {
    expect(missingRoleTools(ALL_TOOLS, role("explorer"))).toEqual([]);
  });
});

describe("canDelegate (阀 3a: 委派白名单)", () => {
  it("reviewer 可以派 explorer", () => {
    expect(canDelegate("reviewer", "explorer")).toBe(true);
  });

  it("explorer 不能派 researcher(不在白名单)", () => {
    expect(canDelegate("explorer", "researcher")).toBe(false);
  });

  it("未知当前角色 → false(不抛)", () => {
    expect(canDelegate("ghost", "explorer")).toBe(false);
  });
});

describe("深度闸 (阀 3b: depth > MAX_DEPTH)", () => {
  it("主=0 → reviewer=1 → explorer=2 合法", () => {
    expect(MAX_DEPTH).toBe(2);
    expect(canSpawnAtDepth(0)).toBe(true);
    expect(canSpawnAtDepth(1)).toBe(true);
  });

  it("depth=2 的子代理不能再派(depth+1 > 2)", () => {
    expect(canSpawnAtDepth(2)).toBe(false);
  });
});

describe("CrewRegistry", () => {
  it("解析内置角色", () => {
    const crew = new CrewRegistry();
    expect(crew.get("explorer")?.type).toBe("explorer");
    expect(crew.get("researcher")?.type).toBe("researcher");
    expect(crew.get("reviewer")?.allowedDelegates).toContain("explorer");
  });

  it("未知 type → undefined", () => {
    expect(new CrewRegistry().get("nope")).toBeUndefined();
  });

  it("自定义角色可注册", () => {
    const crew = new CrewRegistry();
    crew.register({
      type: "coder",
      summary: "写代码",
      systemPrompt: "你是 coder",
      allowedTools: ["write", "edit", "bash"],
      allowedDelegates: []
    });
    expect(crew.get("coder")).toBeDefined();
  });
});
