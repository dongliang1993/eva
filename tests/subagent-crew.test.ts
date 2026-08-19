import { describe, expect, it } from "vitest";

import {
  CrewRegistry,
  filterToolsForRole,
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
  "web_search", "web_fetch"
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
