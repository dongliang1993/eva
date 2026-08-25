import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CORE_TOOL_NAMES,
  MAX_DISCOVERY_ACTIVATED_TOOLS,
  ToolDiscoveryController,
} from "../packages/harness/src/agents/tool-discovery.js";
import {
  resolveToolExposure,
  TOOL_COUNT_SAFETY_LIMIT,
} from "../packages/harness/src/agents/tool-safety-net.js";
import { buildTool, type AgentTool } from "../packages/harness/src/tools/index.js";
import { rankToolCatalog } from "../packages/harness/src/tools/tool-search/index.js";

const probeTool = (name: string, description = `probe ${name}`): AgentTool =>
  buildTool({
    name,
    description,
    inputSchema: z.object({ n: z.number().optional() }),
    execute: async () => `${name} ok`,
  });

const toolMap = (count: number, extraNames: readonly string[] = []) => {
  const map = new Map<string, AgentTool>();
  for (let i = 0; i < count; i += 1) map.set(`filler-${i}`, probeTool(`filler-${i}`));
  for (const name of extraNames) map.set(name, probeTool(name));
  return map;
};

describe("rankToolCatalog", () => {
  it("ranks exact/name-token matches first and honors limit", () => {
    const catalog = new Map<string, AgentTool>([
      ["read_file", probeTool("read_file", "Read a file from the workspace")],
      [
        "mcp__github__create_issue",
        probeTool("mcp__github__create_issue", "Create a GitHub issue"),
      ],
      ["web_fetch", probeTool("web_fetch", "Fetch a web page")],
    ]);

    expect(rankToolCatalog("read_file", catalog, 8)[0]?.name).toBe("read_file");

    const github = rankToolCatalog("github issue", catalog, 8);
    expect(github[0]?.name).toBe("mcp__github__create_issue");

    expect(rankToolCatalog("file", catalog, 1)).toHaveLength(1);
    expect(rankToolCatalog("does-not-exist", catalog, 8)).toEqual([]);
  });
});

describe("resolveToolExposure + ToolDiscoveryController", () => {
  it("45 tools without activeToolNames enter discovery mode with core tools active", () => {
    const tools = toolMap(45, [
      "tool_search",
      "read_file",
      "write_file",
      "bash",
      "mcp__x__y",
    ]);
    const discovery = new ToolDiscoveryController();

    const exposure = resolveToolExposure(tools, undefined, discovery);

    expect(exposure.degraded).toBe(true);
    expect(exposure.totalCount).toBe(tools.size);
    expect(exposure.activeTools).toEqual(
      CORE_TOOL_NAMES.filter((name) => tools.has(name)),
    );
    expect(exposure.activeTools).not.toContain("mcp__x__y");
    expect(discovery.isDiscoveryMode()).toBe(true);

    const activation = discovery.activateTools(["mcp__x__y"]);
    expect(activation.added).toEqual(["mcp__x__y"]);
    expect(discovery.activeTools()).toContain("mcp__x__y");
  });

  it("explicit activeToolNames win and skip discovery mode", () => {
    const tools = toolMap(45, ["tool_search", "read_file", "mcp__x__y"]);
    const discovery = new ToolDiscoveryController();

    const exposure = resolveToolExposure(
      tools,
      ["read_file", "mcp__x__y", "missing_tool"],
      discovery,
    );

    expect(exposure.degraded).toBe(false);
    expect(exposure.activeTools).toEqual(["read_file", "mcp__x__y"]);
    expect(discovery.isDiscoveryMode()).toBe(false);
    expect(discovery.activeTools()).toEqual(["read_file", "mcp__x__y"]);
  });

  it("merges preferredToolNames into the initial active set in discovery mode", () => {
    const tools = toolMap(45, ["tool_search", "read_file", "bash", "mcp__x__y"]);
    const discovery = new ToolDiscoveryController();

    const exposure = resolveToolExposure(tools, undefined, discovery, [
      "mcp__x__y",
      "missing_tool",
    ]);

    expect(exposure.degraded).toBe(true);
    expect(exposure.activeTools).toContain("mcp__x__y");
    expect(exposure.activeTools).toContain("tool_search");
    expect(exposure.keptCount).toBe(exposure.activeTools?.length);

    const small = toolMap(30, ["tool_search", "mcp__x__y"]);
    expect(
      resolveToolExposure(small, undefined, discovery, ["mcp__x__y"]).activeTools,
    ).toBeUndefined();
  });

  it("at or under the limit leaves tools unrestricted", () => {
    const tools = toolMap(TOOL_COUNT_SAFETY_LIMIT - 1, ["tool_search"]);
    const discovery = new ToolDiscoveryController();

    const exposure = resolveToolExposure(tools, undefined, discovery);

    expect(tools.size).toBe(TOOL_COUNT_SAFETY_LIMIT);
    expect(exposure.degraded).toBe(false);
    expect(exposure.activeTools).toBeUndefined();
    expect(discovery.activeTools()).toBeUndefined();
  });

  it("caps activated tools and reports omitted names", () => {
    const tools = toolMap(45, ["tool_search", "read_file"]);
    const discovery = new ToolDiscoveryController();
    resolveToolExposure(tools, undefined, discovery);

    const names = Array.from({ length: MAX_DISCOVERY_ACTIVATED_TOOLS + 6 }, (_, i) => `filler-${i}`);
    const activation = discovery.activateTools(names);

    expect(activation.added).toHaveLength(MAX_DISCOVERY_ACTIVATED_TOOLS);
    expect(activation.omitted).toHaveLength(6);
    expect(discovery.activeTools()).toHaveLength(
      CORE_TOOL_NAMES.filter((name) => tools.has(name)).length +
        MAX_DISCOVERY_ACTIVATED_TOOLS,
    );
  });
});
