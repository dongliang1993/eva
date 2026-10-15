import { describe, expect, it } from "vitest";

import {
  SUBAGENT_ROLES,
  missingRoleTools,
  subagentDefinitions,
  type SubagentRole,
} from "../../../apps/server/src/modules/subagents/index.js";
import type { ModelBinding, PipelineTool } from "../../../packages/harness/src/index.js";
import { resolveSubagentTools } from "../../../packages/harness/src/query/subagent-tool.js";

// a stub PipelineTool
const stubTool = (name: string): PipelineTool =>
  ({ name, tool: {} as never }) as unknown as PipelineTool;

const ALL_TOOLS = [
  "read_file", "list_dir", "grep", "read_skill",
  "write", "edit", "bash",
  "web_search", "web_fetch",
  "enter_plan_mode", "exit_plan_mode",
  "report"
].map(stubTool);

const model = { languageModel: {} as never, id: "openai:tool" } satisfies ModelBinding;

/** 角色最终拿到的工具 = server 的定义经 harness 的 subagent 工具过滤(端到端同一条路)。 */
const toolsFor = (tools: readonly PipelineTool[], type: string): string[] => {
  const definition = subagentDefinitions(tools, model)[type];
  if (definition === undefined) throw new Error(`role ${type} not listed`);
  return resolveSubagentTools(tools, definition).map((t) => t.name);
};

describe("subagentDefinitions (阀4: 工具集收窄)", () => {
  const role = (type: string): SubagentRole =>
    SUBAGENT_ROLES.find(role => role.type === type)!;

  it("explorer 拿不到 write/edit/bash", () => {
    const names = toolsFor(ALL_TOOLS, "explorer");
    expect(names).toContain("read_file");
    expect(names).toContain("grep");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("bash");
  });

  it("reviewer 也拿不到写工具;任何角色都拿不到 plan mode 工具", () => {
    const names = toolsFor(ALL_TOOLS, "reviewer");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("bash");
    for (const r of SUBAGENT_ROLES) {
      expect(toolsFor(ALL_TOOLS, r.type)).not.toContain("exit_plan_mode");
    }
  });

  // 会话没绑工作区时,基础集里压根没有文件工具(它们挂在 workspace 守卫内)。
  // 过滤只会静默留下 read_skill —— 子代理于是"没有手却被要求读代码",
  // 实测会编造目录树。所以角色的核心工具缺席时不列出这个角色(模型看不见它)。
  it("基础集缺文件工具时 → explorer 不列出(不派残废子代理)", () => {
    const withoutFsTools = ["read_skill", "web_search", "web_fetch", "read_file"].map(stubTool);
    expect(missingRoleTools(withoutFsTools, role("explorer"))).toEqual(["list_dir", "grep"]);
    const definitions = subagentDefinitions(withoutFsTools, model);
    expect(Object.keys(definitions)).toEqual(["researcher"]);
  });

  it("基础集齐全时 → 全部角色列出,模型 = 工具槽位", () => {
    const definitions = subagentDefinitions(ALL_TOOLS, model);
    expect(Object.keys(definitions)).toEqual(SUBAGENT_ROLES.map((r) => r.type));
    expect(definitions.explorer?.model).toBe(model);
    expect(definitions.explorer?.description).toBe(role("explorer").summary);
  });
});
