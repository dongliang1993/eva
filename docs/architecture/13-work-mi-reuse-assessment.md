# 13 · work-mi 复用评估：能不能作为落地起点

> 注：本篇评估完成于 work-mi 改名 eva 之前。评估对象 work-mi 即现在的 eva（已改名，Sentry/Wave/local-agent 三个业务子系统已删除）。文中"work-mi"指评估时的历史状态，保留原貌不改。

> 评估对象：`/Users/liang.dong/dev/desktop-rescue/self-learn/work-mi/`（pnpm monorepo，Eva / Work MI）。
> 评估目的：判断它能不能作为我们 11 篇落地计划（S0–S11）的起点，哪些直接复用、哪些改造、哪些重写、哪些缺失。
> 证据来源：直接读 work-mi 的源码（packages/harness、apps/server、apps/desktop、apps/web、packages/wave-sdk）+ db schema + electron-builder.yml + 设计文档。标注【实证】= 读到的代码；【推断】= 基于代码的判断。

---

## 0. 一句话结论

**能，而且复用价值极高——它是 S0–S5 的一个已完成实现，只是 SDK 栈选了 LangChain（不是我们定的 Vercel AI SDK）、消息模型不是 UIMessage 整存、缺版本树、缺槽位系统、子代理是同步阻塞的。** 改造点明确且集中（harness 的 LangChain→Vercel AI SDK + 加版本树 + 加槽位），不是推倒重写。

**但它有一个根本性的定位差异需要你先决策**：work-mi 是「Sentry 事件分析助手」（incident ops），它的工具/skill/prompt 都是围绕 Sentry + 代码定位的；我们要的是「通用 coding agent + 平台」。复用的是**引擎和壳**，不是业务。

---

## 1. 技术栈对位（已定决策 vs work-mi 现状）

| 决策（11 §1） | work-mi 现状 | 对位 | 复用处置 |
|---|---|---|---|
| Agent SDK: Vercel AI SDK | **LangChain**（`@langchain/core/messages`、`concat`）【实证】 | ❌ 不一致 | 改造：harness 的 `models/` + `LeadAgent` 重写（见 §3） |
| HTTP: Express 5 | **Fastify**【实证】 | ❌ 不一致（但更轻） | **建议改决策：跟 work-mi 用 Fastify**，见 §5 |
| DB: better-sqlite3 + WAL | better-sqlite3 + drizzle，但 WAL 未见【实证 schema.ts】 | ✅ 一致（drizzle 同源） | 直接复用，补 `PRAGMA journal_mode=WAL` |
| 桌面: Electron mac-only | Electron，mac arm64 + win x64【实证 builder.yml】 | ⚠️ 多了 win | 砍 win target，保留 mac arm64 |
| 本地优先 | ✅ desktop `utilityProcess.fork` 拉 server 子进程 + 动态端口 + 健康检查【实证 main.ts】 | ✅ 完美对位 | **直接复用**，这是全项目最值钱的一块 |
| provider: Anthropic 起步 | OpenAI 兼容（`openai-compatible.ts`），多 provider 表【实证】 | ⚠️ provider 不同 | provider 表保留，`AgentModel` 实现换 `@ai-sdk/anthropic` |

**两个冲突点的处置建议**：
- **Fastify vs Express**：work-mi 用 Fastify 且已实现完整路由。建议**改我们的决策为 Fastify**——Fastify 更轻、TS 体验更好、路由即函数，且省掉重写 server 的工作量。Express 的唯一优势是「和 Alma 同源」，但 Alma 同源不等于我们要同源（这个理由在 11 §1.1 已经被否定过一次了）。
- **LangChain vs Vercel AI SDK**：这个不能跟 work-mi。work-mi 的 `LeadAgent` 手写 loop 强耦合 LangChain 的 `AIMessage`/`AIMessageChunk`/`concat`，且 AGENTS.md 自述「manual tool_call metadata tracking to handle LangChain concat compatibility」——这是 LangChain 的痛点。Vercel AI SDK 的 `streamText` + `stopWhen` 不需要手写 loop、不需要手动 concat、chunk 协议直接转发。**harness 要重写**，但设计（compact/budget/observer）可保留。

---

## 2. 落地计划切片覆盖度（S0–S11）

| 切片 | work-mi 状态 | 证据 | 复用处置 |
|---|---|---|---|
| **S0 地基** | ✅ 已实现 | desktop fork server + 动态端口 + `waitForServer` 健康检查 + shell env 注入 + 系统代理【main.ts】 | **直接复用**，补 loopback token（见坑） |
| **S1 会说话的壳** | ⚠️ 部分实现 | harness `LeadAgent.stream()` + server `runs.ts` SSE + web SSE 消费【实证】 | engine 换 Vercel AI SDK；前端三红线要补（见 §4） |
| **S2 存储版本树** | ⚠️ 部分 | sessions/messages 表【schema.ts】。消息是 `MessageContentBlock[]` JSON 整存（text/thinking/tool_use/tool_result 块），接近 UIMessage 但非完全。有 FTS5 搜索。**无版本树**（无 parent/slot/depth） | 消息块模型可保留；**补 parent/slot/depth 版本树** |
| **S3 工作区** | ⚠️ 部分 | `local_agent_issues` 有 `worktreePath`/`branchName`【schema.ts】——有 worktree 概念但无 workspace 抽象 | 补 workspaces 表 + 导入项目流程 |
| **S4 工具审批** | ⚠️ 部分 | harness 有完整工具系统（tools.ts），`toolPolicy` 字段【schema.ts】，但**无审批闸门** | 补危险工具审批（04 §7 代码5） |
| **S5 Skill** | ✅ 已实现 | `skills/loader.ts` SKILL.md 渐进披露（bundled + project 双源）【实证】 | **直接复用**，和 Alma 04 §4.1 一致 |
| **记忆系统（加分）** | ✅ 已实现 | DB+sqlite-vec(BGE-M3 1024维)+FTS5+query rewriting 混合检索【实证 memory-recall.ts】。**比 Alma 05 P0 还完整** | **直接复用**，这是 work-mi 最大资产之一 |
| **S6 扩展槽位** | ❌ 缺失 | 无 manifest/exposes/eh/slots | **全新建**（09 篇） |
| **S7 子代理 fork-join** | ⚠️ 部分 | `subagents/executor.ts` 有 timeout/disallowedTools/allowed tools，但**同步阻塞、无 fork-join/run_in_background/resume**【实证】 | 补 fork-join（08 §7） |
| **S8 MCP** | ❓ 待查 | 未见 mcp 路由 | 可能缺失，待 agent 结果确认 |
| **S9 Git 面板** | ❌ 缺失 | 无 git 路由 | 新建（=S6 验收扩展） |
| **S10 数据源 Gateway** | ⚠️ 有通道范例 | `wave-sdk` 是 HoYoWave IM 客户端（发消息/回调验签），**不是通用数据源 Gateway**（无 database/tapd/miline 抽象）【实证 types.ts/app/client.ts】 | 复用 wave-sdk 作 Wave bot 通道；通用 Gateway（database 域 + 外部 HTTP 代理）**另建** |
| **S11 桌面化** | ⚠️ 部分 | dmg 打包、loading 窗、单实例逻辑部分【builder.yml + main.ts】；**无 updater/托盘/快捷键/深链** | 补 electron-updater + 托盘 + 深链 |

**覆盖度小结**：S0 直接复用；S1/S2/S4/S7 部分复用（改 engine + 补版本树/审批/fork-join）；S5/S10 直接复用或复用思路；S6/S9 全新建；S11 补完。**大概省掉 40-50% 的工作量**，主要省在 S0（desktop+server 骨架）和 S5（skill）。

---

## 3. harness 改造：LangChain → Vercel AI SDK（最核心的改造）

**耦合点**【实证】：
- `models/agent-model.ts`：`AgentModel` 接口返回 `AIMessage`/`AIMessageChunk`（LangChain 类型）
- `agents/lead-agent.ts`：import `@langchain/core/messages`（`AIMessage`/`HumanMessage`/`SystemMessage`/`ToolMessage`）+ `@langchain/core/utils/stream` 的 `concat`；手写 `for step` loop + `readModelReply` + `executeToolCalls`
- `subagents/executor.ts`：用 `createAgent`（内部 LeadAgent）
- `context/runtime-compact.ts`、`context/tool-result-budget.ts`：操作 `BaseMessage[]`

**改造范围**：
1. `AgentModel` 接口 → 换成 Vercel AI SDK 的 `LanguageModel`（或直接用 `@ai-sdk/anthropic` 的 model 对象）
2. `LeadAgent` → 两个选择：
   - **选项 A（推荐）**：用 Vercel AI SDK 的 `streamText({ model, messages, tools, stopWhen })` 替换手写 loop，chunk 直接转发（04 §7 的 runAgent 骨架）。compact/budget 作为 `prepareMessages` 前置处理保留。
   - **选项 B**：保留手写 loop，只把 LangChain 类型换成 Vercel AI SDK 的 `CoreMessage`。改动小但放弃了 SDK 的 stopWhen/自动 tool 配对。
3. `runtime-compact.ts`/`tool-result-budget.ts` → 类型从 `BaseMessage[]` 换成 `CoreMessage[]`，逻辑不变（这两块设计很好，保留）
4. `tools.ts` → 工具定义从 LangChain `StructuredToolInterface` 换成 Vercel AI SDK `tool({ description, parameters: zod, execute })`（04 §2.2）

**可保留的真东西**（这些是 work-mi 比 Alma 04 还细的地方）：
- `context/runtime-compact.ts`：proactive（每 step 前）+ reactive（出错重试）双策略 compact，带 stats【实证】——比 Alma 04 §6.2 的 compact 更完整
- `context/tool-result-budget.ts`：tool-result 预算控制——这是 tool-overflow 的近亲
- `agents/observer.ts`：遥测事件（agent_run_start/end、loop_transition、context_compacted、llm_call_start/end、tool_call_start/end）——完整的可观测性
- `max-output-continuation`：max_output_tokens 续写恢复【lead-agent.ts L618-635】——Alma 没有这个

---

## 4. 前端（apps/web）三红线评估【实证】

**技术栈**（现代且对齐）：React 19.1 + Vite 6.3 + React Router 7 + TanStack Query 5 + Tailwind v4 + Radix（手写非 shadcn）+ Streamdown 2.5。可复用。

**三红线：全部未达标，必须重写**【实证 `hooks/use-chat.ts:161-177` + `message-bubble.tsx:58`】：

| 红线（01 §7） | work-mi 现状 | 问题 |
|---|---|---|
| ① seq 重组 | SSE event **无 seq 字段**，直接 append | 乱序/重复 delta 会错位 |
| ② rAF 字符泵 | 每个 chunk 立即 `setMessages(prev.map(...))` | token 突发到达全量 setState，顿挫 |
| ③ markdown 分块 memo | `<Streamdown>{message.content}</Streamdown>` 全量喂 | 每次重解析全篇 markdown |

且 `MessageList` 朴素 `.map` 无虚拟化（`message-list.tsx:28-34`），长对话必卡。

**目录**：pages/components/hooks 层式分类，**非 feature-domain**【实证】。无 `features/`/`slots/`/`eh/`。要按 10 §2 重构成 features/shared/slots。`types/api.ts:16` 用相对路径 re-export shared（应改 `@work-mi/shared` workspace 别名）。

**可复用的资产**：技术栈本身、`sidebar.tsx`（会话列表）、`tool-call-block.tsx`（工具展示）、`chat-input`（模型选择+发送）、`use-settings`、`api/fetch.ts`（throw on non-2xx）——作为 features 的起点组件。

**复用度：骨架 40%**。流式必重写（上三红线），目录必重构。

---

## 5. shared 包评估【实证 `packages/shared/src/index.ts`】

纯类型包（~326 行，零依赖，server + web 共用），复用度 **80%**。导出分 10 类：

| 类型组 | 复用价值 | 备注 |
|---|---|---|
| **Provider/Model** | ⭐⭐⭐⭐⭐ | `ProviderType`(含 anthropic/openrouter/deepseek/...)、`ProviderModelCapabilities`、`Provider`——多 provider 抽象直接可用 |
| **AppSettings** | ⭐⭐⭐⭐⭐ | 完整设置 schema（general/chat/security/memory/toolModel/channels）——配置中心直接搬 |
| **Thread/Memory/Skill** | ⭐⭐⭐⭐ | `ThreadSummary`/`ThreadMessage`/`MemoryRecord`/`SkillSummary`——会话/记忆/技能类型 |
| IM 抽象 | ⭐⭐⭐ | `ImIncomingMessage`/`ImOutgoingMessage`——跨通道抽象，单通道时用不上 |
| Sentry 相关 | ❌ | `StackFrame`/`SentryIssue` 等——剥 Sentry 时删掉 |
| Helpers | ⭐⭐⭐ | `isRecord`/`toRecord`/`asString`/`toErrorMessage` |

**要补**：槽位/扩展/工作区相关类型（当前无）。**要改**：web 侧 `types/api.ts:16` 相对路径 re-export → `@work-mi/shared` workspace 别名。

---

## 6. 关键决策点（需要你拍）

### 决策 A：Fastify 还是 Express？
- work-mi 用 Fastify 且已实现 12 个路由域。跟 work-mi 用 Fastify = 省重写 server。
- 建议**改决策为 Fastify**。需要我改 11 §1 和 02/03 篇的 Express 引用。

### 决策 B：harness 选项 A 还是 B？
- A：用 Vercel AI SDK `streamText` + `stopWhen` 替换手写 loop（推荐，符合 04 §7 骨架）
- B：保留手写 loop，只换类型（改动小但放弃 SDK 能力）
- 建议 **A**。

### 决策 C：消息存储改 UIMessage 整存吗？
- work-mi 是拆字段存（role/content/metadata/searchText）。
- Alma 03 §4.3 是 UIMessage 整存 JSON（前端 useChat 零转换）。
- 建议**改 UIMessage 整存**（和 04 §7 骨架一致），但这要改 server 的 message repository + 前端的消息渲染。改造量中等。

### 决策 D：复用 work-mi 还是 fork 还是参考？
- 直接在 work-mi 上改 = 最快，但 work-mi 有 Sentry 业务（sentry-analyzer 包、sentry 工具、sentry 路由）要剥
- fork 出来剥业务 = 干净
- 只参考、新建 = 浪费已有的 desktop+server 骨架
- 建议**fork + 剥 Sentry 业务**，保留引擎和壳。

---

## 7. 坑（复用时要处理的）

| # | 坑 | 证据 | 对策 |
|---|---|---|---|
| 1 | **无 loopback token** | main.ts `waitForServer` 打 `/v1/health` 无 token；server app.ts 无鉴权中间件 | 加 token 中间件（02 §9.5），desktop fork 时传 token |
| 2 | **server 路径 `/v1/` 前缀** | health 是 `/v1/health`【main.ts L231】 | 和 Alma 的 `/api/` 不同，统一选一个 |
| 3 | **消息无版本树** | schema.ts messages 表无 parent/slot/depth | 补三字段 + 索引（03 §4.1） |
| 4 | **LangChain concat 痛点** | AGENTS.md 自述 manual tool_call metadata tracking | 换 Vercel AI SDK 后此痛点消失 |
| 5 | **win target 要砍** | builder.yml 有 win/nsis | 删 win/nsis 段，mac-only |
| 6 | **Sentry 业务要剥** | sentry-analyzer 包 + sentry 路由 + sentry 工具 + SOUL.md 可能含 Sentry 人格 | fork 后剥，保留通用引擎 |
| 7 | **无 electron-updater** | builder.yml 无 publish 配置 | 补 updater（02 §9.6） |
| 8 | **preload 太窄？** | 只暴露 `getServerPort`【preload.ts】 | 够用，业务全走 HTTP，符合 02 §6；后续按需补 windowControls/deepLink |
| 9 | **Anthropic 不能直接用于 chat runtime** | `OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES` 不含 `anthropic`【agent.ts:38-50】。Anthropic provider 能配置/测连接/拉模型，但 chat agent runtime 只支持 OpenAI 兼容类型 | 换 Vercel AI SDK 后此问题消失（`@ai-sdk/anthropic` 原生）；否则要加 anthropic transport |
| 10 | **API key 明文存储** | providers 表 `apiKey` 列明文【schema.ts:139】，`encryptApiKeys: false` 默认【settings-store.ts:251】，无加解密代码 | 用 Electron `safeStorage` 或 OS keychain 加密；本地优先下这是安全基线 |
| 11 | **SSE 无中断** | `LeadAgent.stream` 无 AbortSignal，`routes/runs.ts` 无 abort 端点【实证】 | 加 `AbortController` + `POST /runs/:id/abort`（04 §1.5） |

---

## 8. 推荐的落地路径调整（基于 work-mi）

如果决定 fork work-mi，11 篇的切片顺序调整：

```
S0 地基        → 几乎免做：fork + 剥 Sentry + 加 loopback token + 砍 win（2-3天）
S1 会说话的壳  → harness 换 Vercel AI SDK（选项A）+ 前端补三红线（1-2周）
S2 存储版本树  → 消息改 UIMessage 整存 + 补 parent/slot/depth（3-4天）
S3 工作区      → 补 workspaces 表 + 导入项目（3-4天，work-mi 有 worktree 基础）
S4 工具审批    → 补审批闸门（2-3天，工具系统已就绪）
S5 Skill       → 几乎免做：work-mi 已实现（1-2天验收）
S6 扩展槽位    → 全新建（1-2周，09 篇）
S7 子代理      → 补 fork-join/run_in_background/resume（1周，executor 已有基础）
...
```

**净省**：S0（省 80%）、S5（省 80%）、S1/S2/S4/S7 各省 30-50%。S6/S9 仍需新建。

---

## 9. 深挖 agent 已确认的点（原待确认项）

两个深挖 agent 已完成，确认结果：
- **server 路由**：13 个路由域（threads/providers/skills/memories/runs/search/settings/models/health/sentry/agent-issues/hoyowave/static），CRUD 完整，覆盖 Alma 03 篇核心域。**MCP 未实现**（无 mcp 路由）。
- **web 前端三红线**：**全部未达标**，必须重写（见 §4）。
- **wave-sdk**：是 HoYoWave IM 客户端，**不是通用 Gateway**（见 §2 S10 行），仅作 Wave bot 通道复用。
- **shared 包**：纯类型包，Provider/AppSettings/Thread/Memory/Skill 类型直接搬（见 §5）。

**深挖补全的关键发现**（已并入正文）：
1. 消息是 `MessageContentBlock[]` JSON 整存（非拆字段，我之前判断有误，已修正 §2 S2 行）
2. 记忆系统是 DB+sqlite-vec(1024维)+FTS5+query rewriting 完整混合检索，**比 Alma 05 P0 还完整**（并入 §2，新增「记忆系统加分」行）
3. compact 两级：in-loop（proactive+reactive）+ session 级持久化（session_compactions 表）
4. Anthropic 不能直接用于 chat runtime（`OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES` 不含 anthropic）——换 Vercel AI SDK 后消失（并入 §7 坑9）
5. API key 明文存储（并入 §7 坑10）
6. SSE 无中断（并入 §7 坑11）

---

## 10. 总评

| 模块 | 复用度 | 说明 |
|---|---|---|
| **apps/desktop** | ⭐⭐⭐⭐ 70% | Electron 壳直接作起点：utilityProcess.fork server + 动态端口 + 健康探针 + shell env + 系统代理 + 极窄 preload + mac arm64 dmg。补单实例锁/loopback token/托盘/快捷键/深链，删 win 块 |
| **apps/web** | ⭐⭐ 40% | 技术栈对齐（R19+Vite6+RR7+TQ+TW4+Radix）。流式必重写（上三红线），目录必重构（pages→features/shared/slots）。缺槽位/EH/工作区/子代理视图 |
| **packages/harness** | ⭐⭐⭐ 50% | 架构分层清晰（AgentModel 抽象/context 策略/observer）。compact/budget/max-output 恢复比 Alma 04 还细。但 LangChain 耦合到 loop+tools+models 三层，换 Vercel AI SDK 是中偏大改造。子代理是单层同步，无 fork-join |
| **packages/shared** | ⭐⭐⭐⭐⭐ 80% | 纯类型包零依赖。Provider/Model/AppSettings/Thread/Memory/Skill 类型直接搬。补槽位/扩展/工作区类型 |
| **packages/wave-sdk** | ⭐⭐ 仅 Wave 通道 | HoYoWave IM 客户端，鉴权/发消息/回调验签解密完整。仅 Wave bot 通道场景复用；非通用 Gateway |
| **记忆系统**（server 侧） | ⭐⭐⭐⭐⭐ 90% | DB+sqlite-vec(1024维)+FTS5+query rewriting 完整混合检索，比 Alma 05 P0 还完整。最大资产之一 |
| **session/compact**（server 侧） | ⭐⭐⭐⭐ 80% | 线性历史 + 两级 compact（in-loop proactive/reactive + session 级持久化）+ 历史回放剥离 tool 块。补版本树遍历 |
| **Sentry 业务** | ❌ 剥离 | sentry-analyzer 包 + sentry 路由 + sentry 工具 + 部分 SOUL.md。边界清晰，剥起来不难 |

**最大资产**：desktop 本地优先内嵌架构 + 记忆系统混合检索 + shared 类型模型 + harness 的 compact/budget 设计。

**最大债务**：web 流式（朴素 append + 全量 setState + 全量 markdown 重解析）+ harness LangChain 耦合（换 Vercel AI SDK 中偏大改）+ 层式目录（要重构 features/shared/slots）。

**整体复用率：50-60%**（存储/记忆/session/provider/skill/desktop 壳高复用；harness 引擎层换 SDK + web 流式重写 + 槽位/fork-join 新建）。

**结论：fork work-mi，剥 Sentry，换 harness SDK 到 Vercel AI SDK，补版本树/槽位/fork-join/工具审批/SSE 中断。这是比从 S0 空白起步快得多的路径——尤其记忆系统和 desktop 壳直接省掉 S0+S12 两块大头。**
