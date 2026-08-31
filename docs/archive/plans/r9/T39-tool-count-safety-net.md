# T39 · 工具数 >40 安全网（未设 activeTools 退化最小集 + warning）

> 前置：无文件依赖（改动在 agent 工具装配层）。读 `00-overview.md` §3 第 4 条（显式设了 activeTools 就尊重，不钳）。
> Alma 证据：tools 目录 >40 的安全网（PM-011，main:90600-90606）——activeTools 未设时退化最小集 + 记 warning，防 MCP 接入后工具爆炸。

## 1. 问题

Eva 现在的工具数 = 内置 fs/memory/web-fetch/web-search/bash + MCP 接入的 `mcp__<server>__<tool>`。MCP 服务器一多（每个能暴露十几到几十个工具），工具总数会失控。问题：

- **token 成本**：每个工具的 name + description + schema 都进 system/tools 段，50+ 工具轻松吃掉几千 token，且每次调用都带。
- **选择困难**：工具越多模型选错的概率越高（同名/相似描述混淆），repairedToolCall 率上升。
- **Alma 的不变量**：activeTools 未显式设置时，工具数 >40 就退化为最小集 + 记 warning（main:90600-90606）。Eva 现在**没有 activeTools 概念**，也没有这个安全网——MCP 接满后没有任何防线。

## 2. 改动

### 2.1 安全网阈值 + 最小集

新增 `packages/harness/src/agents/tool-safety-net.ts`：

```ts
/** Alma PM-011:工具数超过此值且未显式设 activeTools 时退化。 */
export const TOOL_COUNT_SAFETY_LIMIT = 40;

/**
 * 最小集:对话不爆炸所必需的工具。fs 读写 + bash 是 coding agent 的命脉,
 * 其余(memory/web-*/MCP)在超限时让位。
 */
const MINIMAL_TOOL_NAMES = new Set([
  "read_file", "write_file", "edit_file", "list_dir", "bash"
]);

/**
 * 工具数 > limit 且未设 activeToolNames → 退化到最小集。
 * 返回 { tools, degraded } ,degraded=true 时调用方记 warning。
 */
export const applyToolCountSafetyNet = (
  tools: ReadonlyMap<string, AgentTool>,
  activeToolNames?: readonly string[]
): { tools: Map<string, AgentTool>; degraded: boolean }
```

逻辑：
1. **显式设了 `activeToolNames`** → 按它过滤（尊重用户/上游选择），`degraded: false`。
2. **没设且数量 ≤ 40** → 原样返回，`degraded: false`。
3. **没设且数量 > 40** → 退化到 `MINIMAL_TOOL_NAMES` 交集（实际存在的才留），`degraded: true`。

### 2.2 接线（agent 装配）

`agent.ts:230` 的 `resolveTools` 返回后、`toToolSet` 前（`:268`）插一道：

```ts
const resolved = this.resolveTools(input);
const { tools, degraded } = applyToolCountSafetyNet(resolved, input.activeToolNames);
if (degraded) {
  this.emit({
    type: "tool_count_degraded",
    totalCount: resolved.size,
    keptCount: tools.size,
    limit: TOOL_COUNT_SAFETY_LIMIT,
  });
}
const toolSet: ToolSet = toToolSet([...tools.values()]);
```

`AgentRunInput` 加可选 `activeToolNames?: readonly string[]`（默认 undefined = 走安全网）。事件 `tool_count_degraded` 进 `AgentStreamEvent`，server observer 收到后打 warning（对齐 Alma「记 warning」）。

### 2.3 不动 MCP 装配

MCP 工具照常进 `additionalTools`（server 侧 `agent-factory.ts`），安全网在 harness 统一兜——MCP 不知道自己被退化，也不该知道。要保留某 MCP 工具，上游（将来 S6 扩展/设置页）显式传 `activeToolNames`。

## 3. 涉及文件

修改：

- `packages/harness/src/agents/agent.ts` — `resolveTools` 后接安全网（§2.2）；`AgentRunInput` 加 `activeToolNames`。
- `packages/harness/src/agents/types.ts`（或 stream-event 定义）— 加 `tool_count_degraded` 事件类型。
- `packages/shared/src/stream-events.ts`（若事件要透到 SSE）— 视需要加映射。

新增：

- `packages/harness/src/agents/tool-safety-net.ts` — `TOOL_COUNT_SAFETY_LIMIT` + `applyToolCountSafetyNet`。
- `tests/tool-safety-net.test.ts` — 见 §4。

不动 MCP 装配、不动 toToolSet、不动各工具本体。

## 4. 步骤（测试先行）

1. **RED-1（纯函数）**：`tests/tool-safety-net.test.ts`——
   - 45 个工具 + 无 activeToolNames → 退化到最小集（≤5 个，degraded=true）；
   - 45 个 + 显式 activeToolNames 含某 MCP 工具 → 按 activeToolNames 过滤，degraded=false；
   - 30 个 + 无 activeToolNames → 原样 30 个，degraded=false；
   - 最小集里某工具实际不存在（如没装 bash）→ 只留存在的，不崩。
2. **GREEN-1**：实现 `applyToolCountSafetyNet`，全绿。
3. **RED-2（接线）**：mock agent run，注入 45 个工具、不传 activeToolNames → 断言 `tool_count_degraded` 事件发出、streamText 收到的 tools 是最小集。红。
4. **GREEN-2**：接 §2.2，全绿。
5. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | 45 工具 + 无 activeTools | 退化最小集，发 `tool_count_degraded`，warning 日志 |
| 2 | 45 工具 + 显式 activeTools 含 `mcp__x__y` | 按 activeTools 过滤（含该 MCP），不退化 |
| 3 | 30 工具 + 无 activeTools | 原样通过，不退化 |
| 4 | 退化后最小集缺某工具 | 只留实际存在的，不崩 |
| 5 | **移除实验**：把退化分支改成恒返回全集 | 用例 1 转红（45 工具不再退化）；恢复全绿 |

E2E：接 2-3 个 MCP server（各暴露 15+ 工具）使总数 >40，开新会话发消息 → 日志出现 `tool_count_degraded` warning，实际生效工具为最小集；对话仍能跑（bash/fs 可用）。

## 6. 坑

1. **只在「未显式设 activeTools」时退化**（契约 §3.4）：上游显式传了 activeToolNames 就尊重，哪怕 >40 也不钳——显式选择优先于安全网。
2. **最小集宁小勿大**：超限时只留 coding 命脉（fs 读写 + bash）。memory/web 这类「锦上添花」让位——它们丢了对话还能跑，fs/bash 丢了 coding agent 就废了。但**别把审批需要留白的工具也剪了**导致权限语义变化（剪了 bash 反而更安全，可接受）。
3. **退化要可见**：`tool_count_degraded` 事件 + warning 日志必须发，否则「我配的 MCP 工具怎么没生效」无从下手排查。静默退化是事故。
4. **别在 MCP 装配侧做**：安全网是 harness 的统一兜底，放 MCP 侧会变成「每个工具来源各管各的」，阈值口径不一。统一在 `resolveTools` → `toToolSet` 之间一道。
5. **40 是 Alma 的经验值，不是定律**：先按 40 落地（有 Alma 实证背书），将来若发现 coding 场景 40 太紧（fs+bash+几个 MCP 就超），把 `TOOL_COUNT_SAFETY_LIMIT` 做成可配（settings）——但首版别过度设计，写死 40。
