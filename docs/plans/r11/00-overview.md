# r11 · S25 工具发现与 Skill 渐进披露加固

> 切片编号 **S25**，来源 `docs/architecture/19-alma-v2-tools-skills-sidecars.md` Part 1/2 + `docs/architecture/11-landing-plan.md` S5 红线。
> 前置阅读：19 Part 1.3-1.4（ToolSearch / 安全网）/ Part 2.1（skill 两级披露与注入机制）/ Part 2.3（SKILL.md 格式）；`../r9/T39-tool-count-safety-net.md`；`../r10/00-overview.md` 的任务卡格式。

## 1. 目标

把 Alma 的「别把所有能力一次性灌进上下文」落成三块：

1. **Skill 渐进披露加固**：system prompt 只含 skill 的 `name + description`；完整正文由模型显式调用 `read_skill` 加载。Eva 现状已经接近，本轮把它契约化（阻塞式调用规则 + skill file 寻址规则）并用测试钉死。
2. **工具发现机制**：工具总数超过 40 且未显式 `activeTools` 时进入 discovery mode——首步只暴露 core tools + `tool_search`；模型用 `tool_search` 找到并激活后续 step 可调用的工具。不再像 T39 那样把 MCP/动态工具从 `toolSet` 里整体裁掉。
3. **Skill auto-selection + allowed-tools（对齐 Alma）**：frontmatter 硬校验 `allowed-tools`（缺/非法即不加载，不留 `[]` 兼容债）并支持 `always-inject`；tool 槽位模型做 AutoSkillSelection，选中 skill 落 `session_skill_selections` thread 累积表；`<available_skills>` 只列 always ∪ 累积 ∪ 新选；选中 skill 的 `allowed-tools` 并集（永远补 `bash/read_skill/tool_search`）作为显式 `activeToolNames` 合并进本轮。

## 2. 现状盘点（代码实证）

| 能力 | 现状 | 位置 |
|---|---|---|
| Skill prompt 注入 | ✅ 已只列 `name + description`，但文案是“需要时再读”，不是阻塞式 first action | `packages/harness/src/skills/prompt.ts:4-19` |
| `read_skill` 返回 | ⚠️ 只返回 `skill.content`；缺 `Skill File` 路径与「相对路径按 skill 目录解析」契约 | `packages/harness/src/skills/read-skill-tool.ts:10-31` |
| Skill 正文是否进 prompt | ✅ 不进（`skillsToPromptSection` 不输出 `content`） | T42 用测试钉死 |
| Skill frontmatter | ⚠️ 只认 `name/description`；无 `allowed-tools` / `always-inject` | `packages/harness/src/skills/parser.ts:24-50` |
| Skill 选择 | ❌ 无 AutoSkillSelection / thread 累积；prompt 无条件列全部 metadata | `apps/server/src/services/agent-factory.ts:274-276` |
| 工具超限安全网 | ⚠️ T39 是「裁 Map」：`>40` 只留 fs/bash 最小集，MCP 工具整体消失 | `packages/harness/src/agents/tool-safety-net.ts:39-63` |
| AI SDK 分步限制工具 | ✅ `streamText` 顶层 `activeTools` + `prepareStep` 返回 `activeTools` | `node_modules/ai/src/generate-text/stream-text.ts:481`、`prepare-step.ts:121-124` |
| 包装层保留工具元数据 | ✅ `withConcurrencyCap` / `withApproval` 都 spread `agentTool` | `packages/harness/src/tools/concurrency-cap.ts:58-71`、`with-approval.ts:34-60` |
| `AgentTool` 可检索元数据 | ❌ 只有 `name/readOnly/needsApproval`，description 封在 SDK `tool` 里 | T43 补 `description` |

**结论：S25 不是重做 skill 加载，也不是推翻 T39；T42 只加固契约，T43 把 T39 的「裁工具」升级为「保留 toolSet + activeTools 发现激活」，T44 按 Alma 把 skill 的 `allowed-tools`/auto-selection/thread 累积接到同一套 activeTools 管线上。**

## 3. 执行契约

1. **Skill 注入只能是 metadata**。system prompt 出现 skill 的 `name/description` 之外信息（正文、filePath、allowed-tools）都算回归；正文只走 `read_skill`。
2. **超限不删 `toolSet`**。T43 后 `toToolSet` 仍吃完整 resolved tools；每步发给 provider 的工具由 `activeTools` 控制。调用方显式 `activeToolNames` 永远优先于安全网；skill `allowed-tools` 只作 `preferredToolNames` 合并，不替换全集。
3. **tool_search 首版用确定性 ranker；skill AutoSkillSelection 用 tool 槽位模型**。两者不混：tool_search 要的是低延迟可复现，skill 选择对齐 Alma 用 LLM；LLM 失败时 skill selection 才退 deterministic fallback，且绝不让聊天失败。
4. **激活要收口**。`tool_search` 只激活 top N（默认 8，上限 10），激活总量设 `MAX_DISCOVERY_ACTIVATED_TOOLS = 24`，防多轮搜索后重新撑爆。
5. **退化必须可见**。`tool_count_degraded` telemetry 保留并发 warning；语义从「剩下这些工具」改为「首步 active 这些核心工具，其余用 `tool_search` 激活」。
6. **skill 选中集是 thread 累积，落 `session_skill_selections`**。这是对「getter 而非字段」的有意例外：LLM 选择不可确定重放，active-path 重算既贵也不一致。always-inject 不落表，仍从 frontmatter 现算。
7. **`<available_skills>` 只列选中集**：always-inject ∪ thread 累积 ∪ 本轮新选；不做小目录全量兜底，避免 skill 增长后 metadata 回潮。
8. **allowed-tools 是 preferred 工具契约**：选中 skill 的 `allowed-tools` 并集 + `bash/read_skill/tool_search` 作为 `preferredToolNames`；`<=40` 全集本来就可用，`>40` 并入首步 active（core ∪ preferred，仍受 40 上限）。调用方显式 `activeToolNames` 优先于 skill preferred。

## 4. 任务卡

| 卡 | 文件 | 一句话 | 估时 | 依赖 |
|---|---|---|---|---|
| **T42** | `T42-skill-progressive-disclosure.md` | Skill prompt 只注 metadata（阻塞式文案）+ `read_skill` 返回带 `Skill File` 寻址契约 + 测试钉死 | 0.5 天 | — |
| **T43** | `T43-tool-discovery.md` | `tool_search` + `ToolDiscoveryController` + `resolveToolExposure`：超限首步 core+`tool_search`，搜索激活后下一 step 可用 | 1–1.5 天 | T42（`read_skill` 进 core tools） |
| **T44** | `T44-skill-auto-selection-allowed-tools.md` | 硬校验 `allowed-tools`（缺/非法不加载）+ `always-inject` + tool 槽位 AutoSkillSelection + `session_skill_selections` 累积；selected skills 只注 metadata，`allowed-tools` 作 `preferredToolNames` 合并进 active set | 1–1.5 天 | T42/T43（activeTools 管线与 skill 契约） |

**顺序**：T42 → T43 → T44。T42 小且独立；T43 建 activeTools 管线；T44 复用这条管线接 skill 选择，不再开第二条工具暴露路径。

## 5. 验收总表

| 卡 | 一句话验收 |
|---|---|
| T42 | `skillsToPromptSection` 只含 name/description（测试断言不含正文片段）；命中 skill 时 `read_skill` 返回完整正文 + `Skill File` 路径 + 相对路径解析说明 |
| T43 | 45 工具（含 MCP）无显式 activeTools 时，首步 provider 只收到 core tools + `tool_search`；模拟调用 `tool_search` 后，下一步 provider 收到被激活工具；`tool_count_degraded` warning 仍发出 |
| T44 | 缺/非法 `allowed-tools` 的 `SKILL.md` 不加载（无 `[]` 兜底）；skill 被 LLM 选中后写入 `session_skill_selections` 且下一轮仍在 `<available_skills>`；selected skill 声明 `allowed-tools: [mcp__x__y]` 时，`preferredToolNames` 含 `bash/read_skill/tool_search/mcp__x__y` 且 >40 首步并入；tool 模型失败走 fallback 且聊天不炸 |

S25 切片全绿 = T42–T44 全绿 + `pnpm typecheck && pnpm test` 全绿。
