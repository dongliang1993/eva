# S1 · harness 迁移到 Vercel AI SDK + Anthropic 技术文档

> 状态：技术设计（待实施）。本文档指导 S1 的代码迁移，不是已完成记录。
> 范围：把 `packages/harness` 从 LangChain 迁移到 Vercel AI SDK（`ai@^7` + `@ai-sdk/anthropic`），并让 server 的 provider runtime 支持 Anthropic。
> 依据：`docs/architecture/04`（agent harness 设计）、`11 §1.1`（SDK 选型调研）、`13 §3`（harness 改造评估）。
> 原则：**保留 harness 的架构分层和 loop 控制逻辑（compact/budget/max-output 续写/observer），只换 SDK 适配层。不重写控制逻辑。**

---

## 0. 为什么做这次迁移

当前 harness 硬耦合 LangChain（`@langchain/core` + `@langchain/openai`），有三个痛点：

1. **手写 tool_call 碎片重组**：`lead-agent.ts` 的 `reconstructToolCalls` + `toolCallMeta` Map，是为了兼容「非标准 OpenAI 兼容 API」流式 tool_call 分片到达的补丁（AGENTS.md 自述 "manual tool_call metadata tracking to handle LangChain concat compatibility"）。Vercel AI SDK 的 `streamText` 自己处理 tool_call 累积，这块可删。
2. **Anthropic 不能用于 chat runtime**：`agent.ts` 的 `OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES` 不含 `anthropic`，只能用 OpenAI 兼容协议跑。11 §1 决策已定 provider 起步用 Anthropic Claude——必须打通。
3. **chunk 协议不统一**：LangChain 的 `AIMessageChunk` 和前端的 SSE 事件（`text_chunk`/`tool_call_start`/`tool_call_end`）之间是手写转换，而 Vercel AI SDK 的 stream parts（`text-delta`/`tool-call`/`tool-result`/`finish`）更接近前端要的三红线协议（11 §S1.1）。

迁移后：多 provider 原生支持（换 `@ai-sdk/*` 包即可）、Anthropic 一等公民、chunk 协议更干净、删掉手写 tool_call 重组。

---

## 1. 现状：LangChain 耦合点清单

迁移前必须改的耦合点（每条标注文件 + 证据）：

### 1.1 模型适配层（核心耦合）

**`models/agent-model.ts`** — `AgentModel` 接口签名建立在 LangChain 类型上：
```ts
import type { AIMessage, AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

export interface AgentModel {
  invoke(messages: BaseMessage[], tools: StructuredToolInterface[]): Promise<AIMessage>;
  stream(messages: BaseMessage[], tools: StructuredToolInterface[]): AsyncIterable<AIMessageChunk>;
}
```

**`models/openai-compatible.ts`** — 唯一实现，内部 `new ChatOpenAI(...)` + `bindTools(tools, { tool_choice: "auto", parallel_tool_calls: false })`。`invoke`/`stream` 调 LangChain 的 `.invoke()`/`.stream()`。

### 1.2 agent loop（重度耦合）

**`agents/lead-agent.ts`**：
- import `@langchain/core/messages`（`AIMessage`/`HumanMessage`/`SystemMessage`/`ToolMessage`）+ `@langchain/core/utils/stream` 的 `concat`
- 手写 `for (let step < maxSteps)` loop + 内层 `while(true)`
- `readModelReply`：流式模式 `for await (chunk of model.stream())` + `concat` 累积 + `toolCallMeta` Map 重组碎片 → `chunkToAIMessage`
- `executeToolCalls`：逐个 `tool.invoke(args)` → 包 `ToolMessage` push 进 `state.messages`
- `prepareMessagesForModel`：每步前 `applyToolResultBudget` + `applyProactiveLoopCompact`
- reactive compact：LLM 报 context 超限时压缩消息重试（`isReactiveCompactCandidateError`）
- max-output 续写：`finish_reason=length` 时插 "Continue directly" 重跑（`maxOutputRecoveryLimit`）

**`agents/types.ts`** — `AgentRunInput.messages: BaseMessageLike[]`、`systemPrompt: string | SystemMessage`。`AgentStreamEvent` 是自有的（`text_chunk`/`tool_call_start`/`tool_call_end`/`result`/`error`）——**这个不耦合 LangChain，可保留**。

**`agents/create-agent.ts`** — `appendPromptSection` 处理 `SystemMessage`。

### 1.3 工具层

**`tools.ts`**：
```ts
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
export type AgentTool = StructuredToolInterface;
export const buildTool = <S>(def) => tool(async (input) => ..., { name, description, schema });
```
`ToolDefinition`（name/description/schema/execute/readOnly）是自有抽象，**不耦合 LangChain，可保留**。耦合在 `buildTool` 调 LangChain 的 `tool()` + `AgentTool = StructuredToolInterface`。

### 1.4 context 层（操作 LangChain 消息实例）

- **`context/runtime-compact.ts`**：操作 `BaseMessage[]`，用 `instanceof AIMessage`/`ToolMessage`/`SystemMessage` 判断类型，读 `message.tool_calls`/`message.tool_call_id`/`message.content`。`estimateMessageTokens` 读 `AIMessage.tool_calls`。
- **`context/tool-result-budget.ts`**：操作 `BaseMessage[]`，用 `instanceof ToolMessage` 判断，读 `tool_call_id`/`content`/`status`。
- **`context/policy.ts`**：纯配置（contextWindow/reservedOutputTokens/...），**不耦合 LangChain，完全保留**。

### 1.5 subagents

- **`subagents/executor.ts`**：`createAgent(...)` + `agent.invoke()`，类型上透传 `AgentModel`，不直接碰 LangChain 类型——**间接耦合，改 AgentModel 后自动跟上**。
- **`tools/task/index.ts`**：`buildTool` 包装，改 `buildTool` 后自动跟上。
- **`subagents/registry.ts`**：纯注册表，**不耦合**。

### 1.6 server 侧引用

- **`apps/server/src/agent.ts`**：`OpenAiCompatibleModel` + `OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES`（不含 anthropic）+ `createSentryTools`（已删）。
- **`apps/server/src/services/provider-runtime.ts`**：4 种 transport（openai-compatible/anthropic/google/azure），anthropic 走 `x-api-key` + `anthropic-version`——**provider runtime 已支持 anthropic，只是 agent runtime 没接**。
- **`apps/server/src/services/runs.ts`**：消费 `AgentStreamEvent` 转 SSE——**不耦合 LangChain，保留**。

---

## 2. 目标设计

### 2.1 分层不变，只换适配层

```
保留（SDK 无关）            换掉（LangChain → Vercel AI SDK）
─────────────────────       ────────────────────────────────
ToolDefinition 抽象          AgentModel 接口（CoreMessage）
context/policy.ts           models/openai-compatible.ts → anthropic.ts
context/runtime-compact     models/agent-model.ts
context/tool-result-budget   tools.ts 的 buildTool（tool() 换源）
AgentStreamEvent             lead-agent.ts 的 readModelReply
observer/telemetry           （删 concat/toolCallMeta 重组）
subagents/registry           create-agent.ts 的 SystemMessage 处理
provider-runtime.ts          agent.ts 的 OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES
```

### 2.2 AgentModel 新接口

```ts
// models/agent-model.ts（目标）
import type { LanguageModelV2 } from "ai";

// AgentModel 不再是自定义接口，直接用 Vercel AI SDK 的 LanguageModelV2。
// 但保留一个工厂函数封装 provider 选择 + 多模型槽。
export interface AgentModelFactory {
  (options: { apiKey: string; baseURL?: string; model: string; temperature?: number }): LanguageModelV2;
}
```

`LeadAgent` 不再调 `model.invoke/stream`，改用 `streamText({ model, messages, tools, stopWhen })`。`LanguageModelV2` 是 Vercel AI SDK v5 的统一模型接口，`@ai-sdk/anthropic` 的 `createAnthropic()(...)` 返回它。

### 2.3 消息类型：BaseMessage → CoreMessage

Vercel AI SDK 的 `CoreMessage` union：
- `CoreSystemMessage`（{ role: "system", content }）
- `CoreUserMessage`（{ role: "user", content }）
- `CoreAssistantMessage`（{ role: "assistant", content, toolCalls? }）
- `CoreToolMessage`（{ role: "tool", content, toolCallId }）

context 层的 `instanceof AIMessage` 判断 → 改成 `message.role === "assistant"` 判断。`message.tool_calls` → `message.toolCalls`。`message.tool_call_id` → `message.toolCallId`。

### 2.4 工具：LangChain tool() → Vercel AI SDK tool()

```ts
// tools.ts（目标）
import { tool } from "ai";

export type AgentTool = ReturnType<typeof tool>;  // 或定义最小接口
// ToolDefinition 保留不变
export const buildTool = <S extends z.ZodObject<z.ZodRawShape>>(def: ToolDefinition<S>): AgentTool =>
  tool({
    description: typeof def.description === "function" ? def.description() : def.description,
    parameters: def.schema,
    execute: async (input) => {
      try { return await def.execute(input); }
      catch (e) { return `[Tool Error] ${e instanceof Error ? e.message : "Unknown"}`; }
    }
  });
```

Vercel AI SDK 的 `tool()` 接受 `{ description, parameters: ZodSchema, execute }`——和现有 `ToolDefinition` 几乎一一对应，改动小。

### 2.5 loop：保留手写 loop 还是换 stopWhen？

**两个选项**（文档先列，实施时二选一）：

**选项 A（推荐）：用 streamText + stopWhen 替换手写 loop**
- `streamText({ model, system, messages, tools, stopWhen: stepCountIs(maxSteps), onStep })`
- `onStep` 回调里拿每步的 `step.text`/`step.toolCalls`/`step.toolResults`，转成 `AgentStreamEvent`
- **优点**：删掉 `readModelReply` 的 concat/toolCallMeta 重组，删掉手写 step 循环，SDK 自动处理 tool_call 累积和 result 回灌
- **难点**：reactive compact 重试、max-output 续写、tool-result budget 这三个 loop 内自定义逻辑，要包在 `onStep` 或外层——Vercel SDK 的 `stopWhen`/`maxSteps` 不覆盖这些，需要自己加

**选项 B：保留手写 loop，只换模型调用层**
- `LeadAgent.runLoop` 结构不变，只把 `model.stream()` 返回的 `AIMessageChunk` 换成 `streamText` 的 stream parts
- **优点**：compact/budget/max-output 续写的控制逻辑原样保留，改动最小
- **难点**：要手动把 Vercel 的 stream parts（`text-delta`/`tool-call`/`tool-result`）累积回一个 assistant turn，等于自己写一遍 SDK 已有的累积逻辑

**建议选项 A**，但 compact 重试用一个 wrapper：
```
async function runWithReactiveCompact(messages, tools, ...) {
  try { return await runStreamText(messages, tools, ...); }
  catch (e) {
    if (isReactiveCompactCandidate(e) && !triedCompact) {
      messages = applyReactiveLoopCompact(messages);
      triedCompact = true;
      return runStreamText(messages, tools, ...);
    }
    throw e;
  }
}
```
max-output 续写：在 `onStep` 里检测 `step.finishReason === "length"`，插 "Continue directly" user message 后继续（streamText 的多步天然支持）。tool-result budget：每步 `onStep` 开始前 `applyToolResultBudget`。

### 2.6 多模型槽

`agent.ts` 的 `resolveModelBinding` 已经有 mainModel + toolModel 双槽。迁移后：
- `toAgentModel(binding)` 从 `new OpenAiCompatibleModel(...)` 改成 `createAnthropic({ apiKey, baseURL? })(binding.modelId)`（或走 `@ai-sdk/openai-compatible` 支持多 provider）
- `OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES` 加 `"anthropic"`，或重构成 `SUPPORTED_AGENT_PROVIDER_TYPES`（不再叫 openai-compatible）
- 多 provider：`provider.type === "anthropic"` → `createAnthropic`；`openai`/`deepseek`/... → `createOpenAICompatible`（`@ai-sdk/openai-compatible`）

### 2.7 chunk 协议（对接 S1.1 三红线）

`AgentStreamEvent` 保留（`text_chunk`/`tool_call_start`/`tool_call_end`/`result`/`error`），它是 server SSE 和前端的契约，不该为了 SDK 换而改。

`streamText` 的 stream parts → `AgentStreamEvent` 映射：
- `text-delta` → `text_chunk`（content: textPart）
- `tool-call`（streamText 在工具入参流式完成时发）→ `tool_call_start`
- `tool-result` → `tool_call_end`
- `finish` → `result`
- `error` → `error`

S1.1（前端三红线）会在 SSE event 上加 `seq` 字段——S1 阶段先保持现有 SSE 帧格式，S1.1 再加 seq。

---

## 3. 迁移步骤（按依赖顺序）

### Step 1：装依赖 + 加 Anthropic provider 类型
- `packages/harness`: `pnpm add ai @ai-sdk/anthropic`，`pnpm remove @langchain/core @langchain/openai`
- `apps/server`: `pnpm add @ai-sdk/anthropic`（provider runtime 用）
- `shared/index.ts` 的 `ProviderType` 已含 `"anthropic"`，无需改
- **验收**：依赖装上，typecheck 不报缺包（此时代码还引用 LangChain，会报错，正常）

### Step 2：换 tools.ts（最底层，无依赖）
- `buildTool` 从 LangChain `tool()` 换成 Vercel `tool()`
- `AgentTool` 类型重定义
- `ToolDefinition` 保留不变
- **验收**：`tools.ts` 编译过，所有现有工具（memory/web-search/web-fetch/task/read-skill）的 `schema`/`execute` 不动，只换包装

### Step 3：换 models/ 层
- `agent-model.ts`：`AgentModel` → `LanguageModelV2`（或保留 `AgentModel` 别名 = `LanguageModelV2`）
- 删 `openai-compatible.ts`，新建 `anthropic.ts`（`createAnthropic`）+ `openai-compatible.ts`（`@ai-sdk/openai-compatible`，给非 anthropic provider）
- **验收**：`models/` 编译过，能构造出 `LanguageModelV2`

### Step 4：换 context/* 类型
- `runtime-compact.ts` + `tool-result-budget.ts`：`BaseMessage[]` → `CoreMessage[]`
- `instanceof AIMessage` → `message.role === "assistant"`
- `message.tool_calls` → `message.toolCalls`，`message.tool_call_id` → `message.toolCallId`
- `estimateMessageTokens` 读 `CoreAssistantMessage.toolCalls`
- **验收**：context 层编译过，逻辑不变（这是保留的核心）

### Step 5：换 lead-agent.ts（最大块）
- 选选项 A：用 `streamText` + `stopWhen: stepCountIs(maxSteps)` + `onStep`
- 删 `readModelReply` 的 `concat`/`toolCallMeta`/`reconstructToolCalls`/`chunkToAIMessage`
- `executeToolCalls`：Vercel SDK 自动执行工具并回灌，`onStep` 里拿 `step.toolResults`——但若要保留「逐个工具 yield start/end 事件」给前端，要自己从 `step.toolCalls`/`step.toolResults` 拆
- `prepareMessagesForModel`：每步前 `applyToolResultBudget` + `applyProactiveLoopCompact`（逻辑不变，类型换了）
- reactive compact：包 `runWithReactiveCompact` wrapper
- max-output 续写：`onStep` 检测 `finishReason === "length"` 插续写消息
- `AgentStreamEvent` 产出逻辑：从 stream parts 映射（§2.7）
- **验收**：harness typecheck 过，`harness-agent.test.ts` 跑通（测试可能要改 mock，见 §4）

### Step 6：换 create-agent.ts + agents/types.ts
- `BaseMessageLike[]` → `CoreMessage[]`
- `systemPrompt: string | SystemMessage` → `string | CoreSystemMessage`
- `appendPromptSection` 的 `instanceof SystemMessage` → role 判断
- **验收**：create-agent 编译过

### Step 7：换 server/agent.ts
- `toAgentModel`：`new OpenAiCompatibleModel` → `createAnthropic`/`createOpenAICompatible`
- `OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES` 加 `"anthropic"`（或重命名）
- 删 `createSentryTools` 引用（已删，确认无残留）
- **验收**：server typecheck 过

### Step 8：验证
- `pnpm typecheck` 全过
- `pnpm test`：`harness-agent.test.ts` + `subagents.test.ts` + `agent-runtime.test.ts` 可能要改 mock（§4）
- 手动：配 Anthropic provider + claude-sonnet-5，`pnpm web:dev`，发消息能流式回复 + 工具调用正常

---

## 4. 测试影响

现有测试 mock 的是 LangChain 类型，迁移后要改：

- **`harness-agent.test.ts`**：mock `AgentModel`（LangChain `AIMessage`）→ mock `LanguageModelV2`（Vercel stream parts）。L240/303 的 "Analyze a Sentry issue" 描述已是 stale（Sentry 已删），顺手改。
- **`subagents.test.ts`**：L109 `tool2 = { name: "sentry_analyze_issue" }` 是测试数据，不影响逻辑但可改成通用名。
- **`agent-runtime.test.ts`**：测的是 `resolveAgentRuntimeConfig`（provider 选择逻辑），改 `OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES` 后要加 anthropic 用例。
- **`session.test.ts`**：L222 `toolName: "sentry_analyze_issue"` 是历史回放测试数据，可能要改成现有工具名。

**策略**：先让 typecheck 过，再逐个修测试。测试 mock 从「mock 整个 AgentModel」改成「mock `streamText` 的返回」——用 Vercel AI SDK 的 `mockStreamText` 或自己构造 stream parts。

---

## 5. 风险与回退

### 风险
1. **Vercel AI SDK v5 API 变动**：`stopWhen`/`onStep`/stream parts 的确切签名要以装的 `ai@^7` 版本为准，文档基于 v5 推断，实施时对照 `node_modules/ai/dist/index.d.ts`。
2. **compact 重试语义**：选项 A 的 reactive compact 是 wrapper 级重试，可能和原 loop 内重试的「同 step 重试」语义有差。实施时要确认 `isReactiveCompactCandidateError` 在 Vercel SDK 下的等价错误形态。
3. **max-output 续写**：`finish_reason === "length"` 在 Vercel SDK 是 `finishReason === "length"`，但要确认 `streamText` 的 `onStep` 里 finishReason 是否可读。
4. **工具执行可见性**：LangChain 版是逐个 `tool.invoke` 手动 yield start/end；Vercel SDK 自动执行工具，要确认 `onStep` 能否拆出单个工具的 start/end 事件（否则前端工具卡片展示会退化）。

### 回退
- 迁移前打 tag：`git tag pre-s1-migration`
- 每个 Step 独立 commit，出问题可 `git revert` 单步
- 若选项 A 的 compact/续写迁移受阻，退到选项 B（保留手写 loop，只换模型调用层），改动小但能先打通 Anthropic

---

## 6. 不在本次范围

- **前端三红线**（S1.1）：S1 只保证 SSE 事件流不变，seq 重组/rAF 字符泵/Streamdown 分块 memo 是 S1.1。
- **版本树**（S2）：消息存储格式不动。
- **工具审批闸门**（S4）：S1 只换工具定义包装，审批是 S4。
- **fork-join 子代理**（S7）：S1 保留现有同步子代理，fork-join 是 S7。
- **删 `models/errors.ts` 的 `isReactiveCompactCandidateError`**：保留，选项 A 仍用它判断重试。

---

## 7. 验收清单

- [ ] `packages/harness` 无 `@langchain/*` 依赖（`package.json` + import 都清）
- [ ] `pnpm typecheck` 全过（shared/harness/server/desktop）
- [ ] `pnpm test` 全绿（测试 mock 已适配 Vercel SDK）
- [ ] 配 Anthropic provider + claude-sonnet-5，`pnpm web:dev` 发消息能流式回复
- [ ] 工具调用正常：agent 能调 web-search/web-fetch/read-skill，结果回灌继续生成
- [ ] subagent（task 工具）能正常委派
- [ ] compact 仍生效：长对话触发 proactive compact，context 超限触发 reactive compact
- [ ] max-output 续写仍生效：长输出 finish_reason=length 时续写
- [ ] observer 遥测事件仍正常（agent_run_start/end、loop_transition、context_compacted）
- [ ] SSE 事件流不变（text_chunk/tool_call_start/tool_call_end/result/end），前端不破

---

## 8. 实施顺序建议

Step 2（tools.ts）→ Step 3（models/）→ Step 4（context/）→ Step 6（create-agent/types）→ Step 5（lead-agent，最大块放最后）→ Step 7（server/agent.ts）→ Step 8（验证）。

理由：先换无依赖的底层（tools/models/context），再换组装层（create-agent），最后换最复杂的 loop（lead-agent）。每步独立可 typecheck，出问题定位窄。

**开工第一句**：`pnpm --filter @eva/harness add ai @ai-sdk/anthropic`，然后 `pnpm --filter @eva/harness remove @langchain/core @langchain/openai`。
