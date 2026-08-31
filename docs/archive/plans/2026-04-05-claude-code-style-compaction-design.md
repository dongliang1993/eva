# Claude Code 风格 Compact / Context Window 管理设计

## 背景

work-mi 当前的 compact 逻辑只做了一件事：在请求进入 `runs.ts` / `hoyowave.ts` 前，检查历史消息是否过大，如果超过阈值，就调用 `compactSession()`：

- 删除旧消息
- 写回一条 summary message
- 仅保留最近几条消息

这个方案能暂时降低上下文长度，但有 4 个根本问题：

1. **破坏用户可见历史**  
   compact 直接删库，前端回看历史时旧消息消失。

2. **只在请求入口触发一次**  
   当前轮里如果发生多次 `LLM -> tool -> LLM`，tool output 会继续膨胀，但没有任何 loop 内管理。

3. **没有 reactive recovery**  
   如果模型已经报 `prompt too long` / `context overflow`，现在只能失败，不能自动 compact + retry。

4. **没有跨轮 runtime summary 状态**  
   如果改成“只压缩传给模型的 messages 数组”，但又不持久化 summary，那么长会话每轮都要重新总结旧历史，成本过高。

Claude Code 的做法不是“一个 compact 函数”，而是一个完整的 **context window management system**。我们需要借鉴的是这套系统，而不是照搬它的 Bun feature flag 和 Anthropic 专有 API 能力。

## 设计目标

### 必达目标

- **完整历史永远保留在 DB 中**
- **前端永远可以回看完整历史**
- compact **只影响模型可见上下文**
- 支持 **proactive compact** 和 **reactive compact**
- 支持 **当前轮 tool output budget**
- 支持 **max_output_tokens continuation**
- 所有 compact 行为都可观测、可测试、可回放

### 非目标

- 第一阶段不复制 Claude Code 的 `cache_edits` / prompt cache 编辑能力
- 第一阶段不复制 Claude Code 的 `contextCollapse` 复杂投影视图
- 第一阶段不把跨轮历史恢复成完整 `tool_use/tool_result` 轨迹
- 第一阶段不做 destructive DB compact 作为默认行为

## 先看 Claude Code 实际做了什么

参考实现主要在：

- `.refrences/cc/services/compact/autoCompact.ts`
- `.refrences/cc/services/compact/compact.ts`
- `.refrences/cc/services/compact/microCompact.ts`
- 用户给出的 `query()` / `queryLoop()` 主循环

仓库里没有找到另一份独立的“Claude Code 版 compact 设计文档”，所以下面的对照以 `.refrences/cc` 的实际代码行为为准，而不是以二手总结为准。

提炼后，Claude Code 的关键机制是：

### 1. 分离 `state.messages` 和 `messagesForQuery`

- `state.messages` 是当前会话的运行时状态
- `messagesForQuery` 是这一轮真正发给模型的上下文视图

compact 不是直接删“历史”，而是在发请求前逐层改造 `messagesForQuery`，必要时再把 compact 后的结果回写到运行时状态。

### 2. compact 是多层的，不是单层 summary

顺序大致是：

1. `applyToolResultBudget`
2. `snipCompact`
3. `microcompact`
4. `contextCollapse`
5. `autoCompactIfNeeded`
6. `reactiveCompact`
7. `max_output_tokens` recovery

也就是说，**先做便宜、局部、低损失的压缩**，最后才做整体 conversation summary。

### 3. proactive 和 reactive 是两套逻辑

- **proactive compact**：接近阈值时主动 compact
- **reactive compact**：模型已经报 `prompt too long` 后，自动 compact + retry

这个差别很重要。只做 proactive 还不够，因为 tool 调用和 provider 的实际 token 计算可能让请求“突然超限”。

### 4. 有明确的状态机和恢复原因

Claude Code 会把“为什么继续下一轮”记录下来：

- `next_turn`
- `reactive_compact_retry`
- `max_output_tokens_recovery`
- `collapse_drain_retry`
- `stop_hook_blocking`

这不是 UI 细节，而是测试和调试稳定性的关键。

### 5. compact 后会做 reinjection / cleanup

Claude Code 在 compact 后会重新挂回：

- file attachments
- plan mode 信息
- invoked skills
- tool / agent delta attachments
- cache / collapse / session state cleanup

work-mi 不需要复制全部，但必须保留“compact 后重新构造运行时上下文”的思想。

### 6. 按 `queryLoop()` 的真实执行顺序看 Claude Code

如果按你给的 `queryLoop()` 真正展开，Claude Code 做的不是“超限了就 compact 一下”，而是下面这条流水线：

1. 维护两份状态
   - `state.messages`：完整运行时状态
   - `messagesForQuery`：本轮发给模型的投影视图

2. 每轮请求前先做轻量压缩
   - `applyToolResultBudget`
   - `snipCompact`
   - `microcompact`
   - `contextCollapse`
   - `autoCompactIfNeeded`

3. 调模型时会“暂缓抛出”可恢复错误
   - `prompt_too_long`
   - `max_output_tokens`
   - media size error

4. 模型返回后再决定是否恢复
   - `prompt_too_long` -> `collapse drain` 或 `reactive compact`
   - `max_output_tokens` -> 自动插 continuation meta message 再跑下一轮
   - 只有恢复失败，错误才真正透出

5. 如果有 tool use，再进入下一轮
   - 执行 tools
   - 注入 attachment / memory prefetch / skill prefetch
   - 更新 `state.messages`
   - 记录 transition reason

这几点对 work-mi 的直接启发是：

- compact 不能只存在于 route 入口
- compact 不能只是一种 summary
- 错误恢复必须在 agent loop 里做
- “给模型看的上下文”和“给用户看的历史”必须显式分离

## work-mi 现状和关键约束

### 当前架构与 Claude Code 的差异

1. **work-mi 有持久化 DB**
   - `sessions`
   - `messages`
   - `memories`

2. **跨轮历史是扁平化的**
   `SessionService.buildHistory()` 当前会把 assistant 的结构化块压平成普通文本，并丢弃历史中的 `tool_use/tool_result`。

3. **当前轮 loop 仍然是结构化的**
   `LeadAgent` 在一次 agent run 内部，仍会把 `AIMessage` 和 `ToolMessage` 都保存在 runtime `messages` 数组里。

4. **当前 auto-compact 在 route 层，不在 harness loop**
   所以它只能管理“跨轮历史”，不能管理“当前轮工具膨胀”。

### 这意味着我们要拆成两个平面

Claude Code 基本是在一个统一 session state 上做 compact；work-mi 需要更明确地拆成两层：

1. **Session Plane（跨轮）**
   - 管理 DB 中积累的会话历史
   - 构造“下次发给模型的历史视图”
   - 绝不能删用户可见消息

2. **Query Plane（当前轮）**
   - 管理一次 agent run 内 `LLM -> tools -> LLM` 的 working set
   - 重点处理 tool result 膨胀、prompt too long、max output continuation

## 目标架构

```text
Full History Plane (DB, UI-visible, immutable-by-default)
  sessions
  messages
  memories

Session Compact Plane (cross-turn, persistent summary snapshot)
  session_compactions
  buildModelHistory(sessionId, modelLimits, recalledMemoryCandidates)
  MemoryContextBudgeter

Query Compact Plane (in-turn, runtime only)
  ContextWindowManager
  ToolResultBudgeter
  ReactiveCompactRecovery
  MaxOutputContinuation
```

### 运行链路

```text
User input
  -> load full session history
  -> buildModelHistory()
       -> maybe reuse active session compaction
       -> maybe create/update session compaction
       -> inject memory within remaining token budget
  -> LeadAgent.runLoop()
       -> apply tool result budget
       -> maybe proactive loop compact
       -> model call
       -> if prompt too long: reactive compact + retry
       -> if max_output_tokens: append continuation meta message
       -> execute tools
       -> next iteration
  -> persist raw user/assistant messages as usual
```

## 数据模型设计

### `messages` 表：保留为 source of truth

默认不删、不归档、不重写。

这张表继续承担：

- 前端消息展示
- 线程搜索
- 审计与调试
- 未来 full transcript 导出

### 新增 `session_compactions` 表

这是本方案的核心。没有这张表，非破坏式 compact 就会退化成“每轮重做一次摘要”。

但这里要区分：

- **Phase 1a 最小可落地结构**
- **Phase 2+ 再演进的 lineage / versioning 结构**

Phase 1a 建议先用最小版，不要一开始把 lineage、状态机、prompt 版本化全做进去。

#### Phase 1a 最小结构

```sql
CREATE TABLE session_compactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  covered_until_message_id TEXT NOT NULL,
  covered_message_count INTEGER NOT NULL,
  preserved_tail_message_count INTEGER NOT NULL,
  estimated_tokens_before INTEGER,
  estimated_tokens_after INTEGER,
  trigger TEXT NOT NULL,           -- manual | proactive | reactive
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_session_compactions_session_id
  ON session_compactions(session_id);
```

这个版本的语义是：

- 一个 session 同一时刻只保留**一条当前 snapshot**
- 重新 compact 时直接**覆盖/替换**这条 snapshot
- 先不做 `active/superseded` 历史链

#### Phase 2+ 扩展结构

如果后续确认需要做 lineage、质量回溯、prompt 版本升级，再追加这些字段：

```text
parent_compaction_id
status
superseded_at
summary_format
summary_prompt_version
summary_model
metadata
```

### 字段语义

- `covered_until_message_id`
  表示该 summary 已经覆盖到哪条原始消息

- `covered_message_count`
  表示该 summary 实际覆盖了多少条原始消息

- `preserved_tail_message_count`
  表示 summary 之外保留了多少条最近原文消息

- `trigger`
  区分手动触发还是自动触发，便于后续观测

- `id`
  Phase 1a 里仍保留独立 ID，后面要升级到 lineage 结构时不用改主键模型

### 顺序与覆盖范围约束

`covered_until_message_id` 要建立在**稳定排序约定**上。

当前 `message-repository.ts` 的读取顺序是：

- `ORDER BY created_at ASC, rowid`

所以第一阶段可以先约定：

- `buildModelHistory()`、`compact snapshot`、`/threads/:id/messages` 都使用同一套顺序
- `covered_until_message_id` 表示在这套顺序里“覆盖到该消息为止”

如果后续要把 compact 做成跨端严格可重放，再考虑给 `messages` 增加显式 `seq` 字段；第一阶段不必为了这个重做整张表。

### 为什么不用给 `messages` 加 `archived` 标记

`archived` 方案更适合“存储分层 / UI 可折叠归档”，不适合当前目标。

我们的目标不是让消息在 UI 里折叠，而是：

- **原始消息保持原样**
- **模型额外读取一个 compact snapshot**

所以 `session_compactions` 比 `messages.archived_at` 更匹配。

## Server 层改造

### 1. 拆掉当前 destructive route-level compact

当前：

- `runs.ts` / `hoyowave.ts` 里直接 `autoCompactIfNeeded(...)`
- `compactSession()` 删除旧消息

目标：

- runtime path 不再调用 destructive `compactSession()`
- destructive compact 退出默认聊天链路

建议：

- 当前 `compactSession()` 重命名为 `archiveThreadHistory()`，仅保留为显式后台维护能力
- 新增非破坏式 `SessionCompactionService`

### 2. `SessionService` 拆成两个读取面

当前只有：

- `buildHistory(sessionId)` -> 给 agent 用

改为：

- `buildFullHistory(sessionId)`  
  返回 UI / 调试 / 搜索所需的完整原始历史

- `buildModelHistory(sessionId, options)`  
  返回给 agent 的 compact 后模型视图

建议接口：

```ts
interface ModelHistoryBuildOptions {
  modelContextWindow: number
  reservedOutputTokens: number
  currentUserMessageId: string
  recalledMemories?: RecalledMemory[]
  forceCompact?: boolean
  trigger: "auto" | "manual" | "reactive"
}
```

建议额外新增：

```ts
interface BuiltModelHistory {
  messages: HistoryMessage[]
  currentCompactionId?: string
  usedMemoryIds: string[]
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  compacted: boolean
}
```

### 3. `buildModelHistory()` 的行为

#### 无 snapshot 且未超阈值

- 直接返回最近历史
- 不写 `session_compactions`

#### 无 snapshot 但已超阈值

- 生成第一条 compact snapshot
- summary 覆盖老历史
- recent tail 原文保留
- 返回：`summary + preserved tail + current user message`

#### 已有 snapshot 且仍未超阈值

- 直接复用 `summary + delta messages`

#### 已有 snapshot 且再次超阈值

- 以 `existing summary + 新增老消息` 为输入，生成新的 compact snapshot
- Phase 1a 直接覆盖原 snapshot
- Phase 2+ 如果要保 lineage，再引入 `parent/status/superseded`

### 3.5 Phase 1a 的 summary 生成方式

这一点需要明确，不然方案会默认滑向“一上来就加一次 LLM 调用”。

Phase 1a 建议：

- **不引入额外的 LLM summarizer**
- 直接复用当前 `compactSession()` 的确定性文本提取逻辑
- 只是把输出位置从“写回 `messages` 并删旧消息”改成“写到 `session_compactions`”

这样做的好处：

- 零额外模型成本
- 无额外延迟
- 无 summarizer 失败链路
- 先验证“非破坏式 compact 架构”本身

代价也明确：

- 摘要质量有限
- 结构化程度有限
- 不能像 Claude Code 那样把 compact 做成高质量续写上下文

所以更合适的节奏是：

- **Phase 1a**：先用 deterministic summary 跑通整条链
- **Phase 2+**：再把 `CompactionSummarizer` 升级为 LLM 版本

### 4. Memory 注入要纳入 budget，而不是先注入再爆

当前 memory 是先召回，再直接放进 `context.memory`。

这不够用，因为它只产出一段最终字符串，不能参与细粒度 budget。

改造后：

1. 先计算 session compact 后还剩多少 budget
2. 再决定 memory 可用 token 数
3. `maxRetrievedMemories` 只是上限，最终还要受 token budget 限制

建议加一个内部预算：

- `memoryBudgetTokens = min(remainingContext * 0.15, 8_000)`

这样 memory 不会反过来把刚 compact 完的上下文再次顶爆。

因此建议把现有 memory recall 拆成两段：

1. `recallMemories()`  
   返回结构化候选项：

```ts
interface RecalledMemory {
  id: string
  content: string
  score: number
  category: string
  estimatedTokens: number
}
```

2. `renderMemoryContext(memories, tokenBudget)`  
   在 `buildModelHistory()` 里按 budget 截断并渲染最终 prompt block

不要继续让 recall 层直接返回最终 prompt string。

但这件事不应该和 Phase 1a 绑死。更合适的是：

- **Phase 1a**：先保持当前 memory recall 路径不变
- **Phase 1b**：再引入结构化候选和 budget 渲染

### 5. `resolveSessionInput()` 的目标调用顺序

`runs.ts` 当前顺序还是“先拿 history，再 route-level compact，再 recall memory”。

建议改成：

1. 记录当前 user message 到 session
2. 解析 runtime model config，拿到 `contextWindow` / `maxOutputTokens`
3. 召回结构化 memory candidates
4. 调 `buildModelHistory(sessionId, options)`
5. 由 `buildModelHistory()` 决定：
   - 是否复用 active compaction
   - 是否生成新 snapshot
   - 允许多少 memory 进入上下文
6. 产出最终 `RunInput.messages` 和 `context.memory`

也就是说，memory budget 的主导权要从 `runs.ts` 外移到 model history builder。

### 6. 建议新增的 Server 组件

```ts
interface SessionCompactionService {
  ensureModelHistory(sessionId: string, options: ModelHistoryBuildOptions): Promise<BuiltModelHistory>
  compactSession(sessionId: string, trigger: "manual" | "auto" | "reactive"): Promise<BuiltModelHistory>
}

interface SessionCompactionRepository {
  findBySessionId(sessionId: string): SessionCompaction | undefined
  upsert(snapshot: CreateSessionCompactionInput): SessionCompaction
}

interface CompactionSummarizer {
  summarizeSession(input: SessionCompactionInput): Promise<CompactionSummary>
  summarizeRuntime(input: RuntimeCompactionInput): Promise<CompactionSummary>
}
```

这样后面你要替换 summarizer model、升级 summary prompt、或者做质量评估时，不会把逻辑写死在 `runs.ts` 和 `session.ts` 里。

其中 Phase 1a 的实现建议就是：

- `DeterministicCompactionSummarizer`

它内部直接复用现在 `compactSession()` 的文本提取规则，不额外调模型。

## Harness 层改造

## 1. `LeadAgent` 必须抽出共享 run loop

当前 `invoke()` 和 `stream()` 各自维护一套循环；compact / recovery 一旦进入 loop，会导致双份实现、双份 bug。

但这里不能低估工作量。`LeadAgent` 的 streaming 和 non-streaming 路径差异，不只是“如何拿模型输出”：

- tool execution 时机不同
- streaming 需要逐步 yield event
- error 传播和结果收敛路径不同
- 结果结束条件不同

所以这部分应该被视为**单独的中高风险重构**，而不是顺手整理。

建议先做一个结构性重构：

- `runLoop(mode: "wait" | "stream")`
- `invoke()` 和 `stream()` 都调用它

之后再把 compact 状态机放进去。

### 2. 新增 `ContextWindowManager`

建议放在 `packages/harness/src/context/`。

职责：

- 估算当前 working set token
- 对旧 `ToolMessage` 做 budget trimming
- 在 step 之间决定是否需要 loop-level proactive compact
- 处理 reactive compact retry
- 处理 max_output continuation
- 返回新的运行时 `messages`

建议接口：

```ts
interface ContextWindowPolicy {
  contextWindow: number
  reservedOutputTokens: number
  loopCompactBufferTokens: number
  blockingBufferTokens: number
  toolResultBudgetTokens: number
  maxOutputRecoveryLimit: number
}

interface LoopCompactionState {
  hasAttemptedReactiveCompact: boolean
  maxOutputRecoveryCount: number
  transition?:
    | { reason: "next_turn" }
    | { reason: "proactive_loop_compact" }
    | { reason: "reactive_compact_retry" }
    | { reason: "max_output_tokens_recovery"; attempt: number }
}
```

再往下一层，建议把 loop 的核心返回值做成显式状态，而不是把恢复逻辑散在 `invoke()` / `stream()` 里：

```ts
type LoopStepResult =
  | { type: "final"; text: string }
  | { type: "tool_calls"; reply: AIMessage }
  | { type: "retry"; transition: LoopCompactionState["transition"] }
  | { type: "error"; code: NormalizedModelErrorCode; message: string }
```

这样 streaming 和 non-streaming 只是在“如何拿模型输出”上不同，不是在“状态机”上不同。

更保守的落地顺序是：

- 先抽共享状态结构和 helper
- 再判断是否真的要合并成单一 `runLoop()`

不要在同一个阶段里一边重构 loop，一边接 reactive compact，一边改 streaming 事件语义。

### 3. Query Plane 里的 compact 顺序

对齐 Claude Code，但按 work-mi 能力做裁剪：

1. **Tool result budget**
   - 先裁掉旧 `ToolMessage` 里过大的输出
   - 最近一次 tool trajectory 不裁
   - `returnDirect` 工具不裁

2. **Loop-level proactive compact**
   - 如果当前 working set 仍超过软阈值
   - 生成“当前轮内 summary”
   - 保留最近若干个 assistant/tool/user 片段

3. **模型调用**

4. **Reactive compact**
   - 如果 provider 归一化错误为 `prompt_too_long`
   - 做一次更激进 compact
   - retry 一次

5. **Max output continuation**
   - 如果 finish reason / provider 元数据表明输出被截断
   - 自动插入一条 meta user message
   - “直接继续，不要重述”

6. **Post-compact cleanup**
   - 重置当前轮的 tool result budget state
   - 清理 runtime compact marker
   - 重新计算可注入的附加上下文
   - 不动 DB 历史

这个 cleanup 思路是从 Claude Code 的 `runPostCompactCleanup()` 抽象过来的。work-mi 不需要照搬它的 cache / collapse / skill reset，但要保留“compact 完之后需要显式清理运行时派生状态”这个机制。

### 4. 为什么 work-mi 的 loop compact 不需要完全复制 Claude 的 tool pairing 逻辑

Claude Code 的历史里长期保留 `tool_use/tool_result/thinking` 块，因此必须小心保 API invariant。

work-mi 当前跨轮历史已经扁平化：

- 旧 turn 进入下一轮前，只保留 assistant text
- 历史 `tool_use/tool_result` 不会长期存在

所以我们只需要对**当前轮内 runtime messages** 维护这些 invariant，复杂度远低于 Claude Code。

## 模型接口设计

### 当前缺口

`AgentModel.invoke()` / `stream()` 当前只返回 `AIMessage` / `AIMessageChunk`，没有标准化：

- `context overflow`
- `prompt too long`
- `finish_reason = length`
- provider-specific max output hit

没有这个归一化层，就做不好 reactive compact。

### 建议改造

新增模型结果标准化：

```ts
type NormalizedModelErrorCode =
  | "prompt_too_long"
  | "max_output_tokens"
  | "rate_limit"
  | "auth"
  | "unknown"

interface NormalizedModelError extends Error {
  code: NormalizedModelErrorCode
  retryable: boolean
  raw?: unknown
}

interface ModelStepMeta {
  finishReason?: "stop" | "tool_calls" | "length"
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}
```

`OpenAiCompatibleModel` 负责把 provider 差异抹平。

### 同时补齐 model limits

当前 `ResolvedRuntimeModelBinding` 没带 `contextWindow` / `maxOutputTokens`。

建议追加：

```ts
readonly contextWindow?: number
readonly maxOutputTokens?: number
```

来源优先级：

1. provider model capabilities
2. provider runtime cache
3. 安全默认值（如 `128_000` / `8_000`）

没有 model limits，compact 阈值只能写死，后面一定会越来越歪。

### provider 错误归一化还要覆盖哪些场景

第一阶段至少要统一成下面几类：

- `prompt_too_long`
- `max_output_tokens`
- `rate_limit`
- `context_window_exceeded`
- `tool_call_invalid`
- `unknown`

其中真正进入 compact recovery 的只应该是：

- `prompt_too_long`
- `context_window_exceeded`
- `max_output_tokens`

别把所有错误都喂给 compact/retry，不然很容易进入无意义重试。

## Session Plane compact 算法

### 保留策略

建议保留：

- 最近 `2-4` 个完整 user/assistant turn
- 或最近 `8-12` 条消息
- 二者取“更安全”的较大值

并且：

- 不在 user / assistant 中间切断语义单元
- 不把“当前用户输入”压进 summary

### Summary 输入

优先用：

- `existing snapshot summary`（如果存在）
- 加上 `covered_until_message_id` 之后、但在 preserved tail 之前的原始消息

而不是每次都从头总结整段 transcript。

如果当前存在 snapshot，summary 输入应优先是：

- 上一版 `summary`
- 上一版 `covered_until_message_id` 之后的新“老消息”

而不是：

- 从 session 第一条消息重新扫描

这点是这个方案能否真正省成本的关键。

### Summary 输出格式

不要做“聊天纪要式流水账”，而要做“下一轮 agent 能继续工作”的结构化摘要：

```md
Conversation summary:

- User goals and constraints
- Important facts and decisions
- Files / entities / systems discussed
- Unresolved questions
- Pending next actions
```

这点要学 Claude Code：compact summary 是 **给下次推理用**，不是给人读的。

## Query Plane compact 算法

### Tool result budget

旧 `ToolMessage` 内容超过预算时，替换成 stub：

```text
[Tool result omitted due to context budget. Tool: <name>. Original output was larger than <n> chars.]
```

保留：

- tool name
- tool call id
- status
- 简短首段摘要（可选）

这样模型还能知道“做过什么”，但不用重新吞完整输出。

### Proactive loop compact

当当前轮 working set 接近阈值时：

- 将“更早的本轮中间轨迹”压成 runtime summary
- 保留最近一段 assistant/tool/user 交互原文
- 只改本轮 runtime state，不改 DB

runtime compact summary 建议同样结构化：

```md
Runtime summary:

- Tools already called and their useful conclusions
- Intermediate findings worth preserving
- Active sub-problem the agent is currently solving
- Constraints / errors discovered in this run
```

不要把 runtime summary 写成“第 1 步做了什么，第 2 步做了什么”的流水日志。

### Reactive compact

如果模型真的报 `prompt_too_long`：

1. 先检查是否已经 reactive retry 过
2. 若没有，则做更激进 loop compact
3. retry 当前 step
4. 若已试过，则将错误透出

### Max output continuation

如果模型不是 prompt too long，而是输出被截断：

- 追加一条 meta user message：
  `Continue directly. Do not apologize. Do not repeat previous content.`
- recovery limit 默认 `3`

这个机制应放在 harness loop，而不是 route。

## 手动 compact 的产品语义

### 现有 `/api/v1/threads/:id/compact`

现状：删除消息，不适合作为默认产品语义。

### 新语义建议

`POST /api/v1/threads/:id/compact`

- 不删消息
- 生成或更新该 thread 的当前 `session_compaction`
- 返回 compact 统计

示例响应：

```json
{
  "success": true,
  "compacted": true,
  "trigger": "manual",
  "coveredMessageCount": 84,
  "preservedTailMessageCount": 10,
  "estimatedTokensBefore": 96420,
  "estimatedTokensAfter": 18340
}
```

前端：

- 消息列表继续展示完整历史
- 可选显示一个 badge：`LLM context compacted`
- 不需要“消息消失”

补充一点：手动 compact 的语义应当与自动 compact 完全一致，只是 `trigger=manual`。

不要出现两套概念：

- 自动 compact = 非破坏式
- 手动 compact = 删库

这会把产品语义彻底搞乱。

## Claude Code 能抄、但 work-mi 第一阶段不抄的部分

### 直接借鉴

- loop 内 context manager，而不是 route pre-processing
- proactive + reactive 双路径
- `max_output_tokens` continuation
- compaction state / transition reason
- compact 后的 reinjection / cleanup 思路

### 暂不照搬

- `cached microcompact` / cache edits
- `contextCollapse`
- 复杂 attachment reinjection
- Bun feature gate / GrowthBook 远程实验开关
- transcript segment / Kairos 相关逻辑

### 原因

这些能力都高度依赖 Claude Code 自己的：

- Anthropic API 特性
- prompt cache 行为
- message graph / attachment 系统
- session transcript 设施

work-mi 目前没有必要为复制这些机制而引入额外复杂度。

## 分阶段落地建议

当前状态（2026-04-05）：

- Phase 1a 已落地：`session_compactions`、非破坏式 `buildModelHistory()`、`runs.ts` / `hoyowave.ts` / `/threads/:id/compact` 已切到 snapshot compact
- Phase 1b 已落地：memory recall 已改成结构化候选 + budget 渲染，并已接入 `runs.ts` / `hoyowave.ts`
- Phase 2 已基本落地：Harness 已接入 `ContextWindowPolicy`、`tool result budget`、`proactive loop compact`、最小 `reactive compact`、`max_output_tokens` continuation，`LeadAgent` 也已收敛为共享内部 `runLoop()`
- Phase 4 观测面已补齐最小闭环：已新增 `loop_transition` / `context_compacted` telemetry，并接入测试与 server logger

## 测试矩阵

### Session Plane

- compact 后 `messages` 表记录数不变
- `buildModelHistory()` 在超阈值时返回 `summary + tail`
- 第二次 compact 能复用已有 snapshot 语义，不需要再删消息
- `/threads/:id/messages` 仍返回完整历史
- Phase 1a 的 summary 生成不依赖额外 LLM 调用

### Query Plane

- tool result budget 不影响最近一次工具轨迹
- proactive loop compact 后仍能继续 tool calling
- reactive compact 在 `prompt_too_long` 时自动 retry 一次
- `max_output_tokens` 时自动插入 continuation meta message

### Integration

- memory 注入遵守 compact 后剩余 budget
- `runs.ts` 和 `hoyowave.ts` 都走同一套 model history builder
- compact telemetry 记录触发原因、前后 token、所用模型

## 最终建议

work-mi 不应该继续把 compact 设计成“删历史消息”。

最合理、也最接近 Claude Code 的方案是：

1. **DB 永远保留完整会话历史**
2. **新增 `session_compactions` 持久化 compact snapshot**
3. **Server 构造跨轮 `modelHistory`**
4. **Harness 管理当前轮 `working set`**
5. **compact 只作用于模型上下文，不作用于用户可见历史**

这套方案和 Claude Code 的核心思想一致，但更贴合 work-mi 当前的：

- DB 持久化架构
- OpenAI-compatible provider 生态
- memory server-side recall
- 较轻量的 attachment / transcript 模型

如果再用一句话概括这次对照结论：

- **Claude Code 的本质不是“做 summary”，而是“把 context window 管理做成一个状态机系统”**
- **work-mi 要学习的是这个系统边界和执行顺序，而不是照抄它的 Bun/Anthropic 专有实现**
