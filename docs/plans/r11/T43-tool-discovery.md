# T43 · 工具发现机制（`tool_search` + `activeTools` 激活）

> 前置：**T42**（`read_skill` 契约已定；它要进 core tools）。读 `00-overview.md` §3 第 2-5 条。
> Alma 证据：`docs/architecture/19-alma-v2-tools-skills-sidecars.md` Part 1.3「ToolSearch」+ Part 1.4「目录 >40 退化最小集」。差异：Alma ToolSearch 用小模型语义搜索，Eva 首版用确定性 ranker（契约 §3.3）。

## 1. 问题

T39 的安全网是「裁 Map」：工具数 >40 且未显式 `activeToolNames` 时，只留 `read_file/write_file/edit_file/list_dir/bash`。这防住了 token 爆炸，但副作用很硬：

- **MCP 工具整体消失**：用户明明配了 MCP server，超限后模型连「有这个工具」都不知道，只能看到 warning 日志。
- **没有找回路径**：Alma 退化后仍留 `ToolSearch`，模型能搜回工具；Eva 退化后只剩 fs/bash，发现层被一起裁掉。
- **schema 仍按 run 全量或全无**：没有「首步少暴露、后续按需激活」的中间态。

AI SDK v7 已支持 `activeTools`（`streamText` 顶层 + `prepareStep` 结果），可以在**保留完整 `toolSet`** 的前提下，控制每个 step 发给 provider 的工具子集。这就是本卡的落点。

## 2. 改动

### 2.1 `AgentTool` 补可检索元数据

`packages/harness/src/tools/build-tool.ts` 的 `AgentTool` 增加：

```ts
readonly description?: string;
```

`buildTool` / `build-json-schema-tool.ts` 返回对象时带上 `description`。包装层（`withConcurrencyCap` / `withApproval`）已用 `{ ...agentTool }`，字段自然保留，不需要改。

### 2.2 新增 `tool_search` 工具

新建 `packages/harness/src/tools/tool-search/`（遵守工具目录约定）：

```text
tool-search/
  search.ts   # rankToolCatalog：纯函数，确定性排序
  tool.ts     # createToolSearchTool(controller)
  index.ts    # re-export
```

工具契约：

- `name: "tool_search"`，`readOnly: true`，不审批。
- schema：`{ query: string, limit?: number }`，`limit` 默认 8，范围 1-10。
- ranker（首版确定性）：精确名 > 名前缀 > 名子串 > name token overlap > description token overlap；tie-break 用工具名字典序。query 与 name/description 先做 camel/kebab/snake 分词并小写化。
- execute：取 top N 交给 controller 激活，返回文本：
  - `Activated tools (callable from the next model step):` + 每行 `- <name> — <description>`；
  - 若因激活上限被省略，追加 `Omitted due to activation cap: ...`；
  - 无命中时返回 `No tools matched ...`，并提示可用域（builtin/fs/mcp/skill/web）。

### 2.3 新增 `ToolDiscoveryController`

新建 `packages/harness/src/agents/tool-discovery.ts`：

```ts
export const TOOL_COUNT_SAFETY_LIMIT = 40;
export const MAX_DISCOVERY_ACTIVATED_TOOLS = 24;

export const CORE_TOOL_NAMES = [
  "tool_search", "read_skill",
  "read_file", "list_dir", "grep", "write_file", "edit_file", "bash",
] as const;
```

controller 状态：

- `catalog: Map<string, AgentTool>`（per run `reset` 时设置）；
- `activated: Set<string>`（per run 清空）；
- `mode: "full" | "discovery"`。

方法：

- `reset(catalog)`：设置 catalog、清空 activated；mode 由 `resolveToolExposure` 决定后设置。
- `initialActiveTools()`：`CORE_TOOL_NAMES ∩ catalog`（`tool_search` 由 createAgent 注入，必在）。
- `activate(names)`：加入 activated；超过 `MAX_DISCOVERY_ACTIVATED_TOOLS` 的部分进 `omitted`。返回 `{ added, omitted }`。
- `activeTools()`：`mode === "discovery"` 时返回 `core ∪ activated`；否则 `undefined`。

### 2.4 `tool-safety-net.ts` 重写为暴露策略

把「裁 Map」改成「算 `activeTools`」：

```ts
export const resolveToolExposure = (
  tools: ReadonlyMap<string, AgentTool>,
  explicitActiveToolNames: readonly string[] | undefined,
  discovery: ToolDiscoveryController,
): {
  activeTools: readonly string[] | undefined;
  degraded: boolean;
  totalCount: number;
  keptCount: number;
}
```

规则：

1. 显式 `activeToolNames` → 过滤到 catalog 中存在的名字，`degraded=false`。
2. `tools.size <= TOOL_COUNT_SAFETY_LIMIT` → `activeTools=undefined`，`degraded=false`。
3. `tools.size > limit` → `discovery.reset(tools)` + `mode="discovery"`，`activeTools=discovery.initialActiveTools()`，`degraded=true`，`keptCount=activeTools.length`。

`TOOL_COUNT_SAFETY_LIMIT` 从 `tool-discovery.ts` re-export，保持旧 import 路径不破。

### 2.5 agent loop 接线

`packages/harness/src/agents/agent.ts`：

- `createAgent`：先建 `ToolDiscoveryController` + `createToolSearchTool(controller)`，把 `tool_search` append 到工具列表，再统一 `withConcurrencyCap` / `withApproval`。
- `Agent.run`：`resolvedTools = this.resolveTools(input)` 后调用 `resolveToolExposure(resolvedTools, input.activeToolNames, this.toolDiscovery)`。
- `toolSet = toToolSet([...resolvedTools.values()])`（全集，不再裁）。`exposure.activeTools !== undefined` 时给 `streamText` 传顶层 `activeTools`。
- `createPrepareStep`（`context-strategy.ts`）新增可选：
  - `getActiveTools?: () => readonly string[] | undefined` —— 每步返回最新 activeTools（discovery 模式下含 activated）。
  - `extraInstructions?: SystemModelMessage[]` —— degraded 时追加一条 notice：当前只启用核心工具，需要其它工具先调 `tool_search` 激活，激活后下一 step 可调用。
- 返回结果合并：`activeTools` 定义时放进 `prepareStep` 返回值；`extraInstructions` 追加到 `instructions`。

telemetry：`tool_count_degraded` 保留（server 已消费）。注释语义更新为「首步 active core 数」，同步 `packages/harness/src/agents/observer.ts` 与 `apps/server/src/observability.ts` 注释。

### 2.6 不做

- 不做小模型语义 ToolSearch（契约 §3.3）。
- 不做 PTC / `run_script`。
- 不让 `tool_search` 出现在 ranker 结果里（它是 core，永远 active）。

## 3. 涉及文件

新增：

- `packages/harness/src/tools/tool-search/{search.ts,tool.ts,index.ts}`
- `packages/harness/src/agents/tool-discovery.ts`
- `tests/tool-discovery.test.ts`

修改：

- `packages/harness/src/tools/build-tool.ts` — `AgentTool.description`。
- `packages/harness/src/tools/build-json-schema-tool.ts` — 填 `description`。
- `packages/harness/src/tools/index.ts` — 导出 tool-search。
- `packages/harness/src/agents/tool-safety-net.ts` — 重写为 `resolveToolExposure`（re-export limit）。
- `packages/harness/src/agents/agent.ts` — 注入 `tool_search`、接 exposure/activeTools。
- `packages/harness/src/agents/context-strategy.ts` — `getActiveTools` / `extraInstructions`。
- `packages/harness/src/agents/observer.ts` — `tool_count_degraded` 注释语义。
- `apps/server/src/observability.ts` — 同步注释。
- `tests/tool-safety-net.test.ts` — 重写到新语义。
- `AGENTS.md` — discovery mode 说明。

## 4. 步骤（测试先行）

1. **RED-1（ranker）**：`tests/tool-discovery.test.ts`
   - 精确名命中排第一；`mcp__github__create_issue` 用 query `github issue` 能命中；limit 生效；无命中返回空。
2. **RED-2（exposure）**：
   - 45 工具 + 无 activeToolNames → `degraded=true`，`activeTools` = core ∩ catalog（含 `tool_search`，不含 MCP）；
   - 45 + 显式 activeToolNames 含 `mcp__x__y` → 按显式过滤，`degraded=false`；
   - 30 → `activeTools=undefined`。
3. **GREEN-1/2**：实现 §2.1-§2.4。
4. **RED-3（agent 接线）**：MockLanguageModel 捕获 `options.tools`——
   - 45 工具首步只收到 core + `tool_search`；
   - 第一步让模型调 `tool_search`（query 命中某 MCP 工具），第二步 `options.tools` 包含该 MCP 工具；
   - `tool_count_degraded` 仍发出，`keptCount` = 首步 active 数。
5. **GREEN-3**：接 §2.5，全绿。
6. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | 45 工具 + 无 activeTools | 首步 provider 只收到 core tools + `tool_search`；发 `tool_count_degraded` warning |
| 2 | `tool_search` 激活 MCP 工具 | 下一 step provider 收到该 MCP 工具 schema；工具可正常调用 |
| 3 | 45 工具 + 显式 activeTools | 按显式名单发工具，不进 discovery mode |
| 4 | 30 工具 | 不传 `activeTools`，provider 收全集 |
| 5 | 连续多次 `tool_search` | activated 并集生效；超过 24 个激活位时 omitted 可见 |
| 6 | **移除实验**：把 discovery mode 改成直接裁 Map | 用例 2 转红（MCP 工具下一步不可见）；恢复全绿 |

E2E：接 2-3 个 MCP server 使总数 >40，发一条需要某 MCP 工具的请求 → 日志有 `tool_count_degraded` warning；模型先调 `tool_search`，随后能调用目标 MCP 工具。

## 6. 坑

1. **显式 activeTools 优先**：上游显式传了就不要进 discovery mode，哪怕 >40（契约 §3.2）。
2. **`toolSet` 必须保留全集**：`activeTools` 只是每步过滤；如果把 tool 从 `toolSet` 里删掉，激活也救不回来。
3. **首步与后续要一致**：顶层 `activeTools` 管首步，`prepareStep` 管后续；两处都从同一个 controller 取，别各算各的。
4. **激活上限**：`tool_search` 每次 top N，N 虽小，多轮搜索并集仍可能涨回去；`MAX_DISCOVERY_ACTIVATED_TOOLS` 必须硬卡。
5. **退化可见**：`tool_count_degraded` + warning 不能省；否则「MCP 工具怎么没直接出现」无从下手排查。
6. **`read_skill` 是 core**：T42 后它必须在 discovery mode 首步可用，否则 skill 正文也读不到。
