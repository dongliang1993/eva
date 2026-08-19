# T8 · 会话运行时可观测 + LLM 摘要

> 前置：**T7**（LLM 摘要要用 tool 槽位）。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §3。
> 施工图：`docs/architecture/14-eva-architecture.md` §5.2（派生状态）、§4.3（摘要用 toolModel）、§8（context-usage 接口）。

---

## 1. 问题实证

### 1.1 `runs` 台账建好了但没人看得见

R1 T1 建了 `runs` 表、`DrizzleRunRepository`（`start` / `settle` / `findBySessionId` / `failStale`）、进程重启收尾 stale run。**但零路由暴露**：`grep -rn "DrizzleRunRepository" apps/server/src/routes` 只在 `runs.ts` 里写，没有任何读接口。用户和开发者都看不到"这一轮花了多少 token、为什么停的"。

### 1.2 `session.status` 派生态未落地

`docs 14 §5.2` 要求 `session.status` **不落库**、由 `deriveSessionStatus()` 纯派生。现在完全没有这个概念：侧栏的会话列表看不出哪个会话正在跑、哪个在等审批。前端只有单会话内的 `isStreaming` 布尔。

### 1.3 上下文占用不可见

`services/token-estimator.ts` 已有 `estimateModelHistoryTokens`，`ModelBinding` 已有 `contextWindow`，但两者从未相遇。用户不知道自己离 compact 还有多远，只能等它突然发生。

### 1.4 compact 摘要是确定性拼接（D5）

```ts
// apps/server/src/services/compact.ts
const generateSummaryText = (coveredMessages, existingSummary) => { /* bullet 拼接 */ };
```

把每条消息截到 220 字、取最后 4 条用户发言和 4 条助手发言拼成 bullet。`docs 14 §4.3` 要求"摘要用 `toolModel`"。确定性拼接的摘要质量差到**压缩之后模型基本失忆**——这是长会话体验的主要短板。

### 1.5 记忆预算的历史估算丢工具轨迹

```ts
// apps/server/src/routes/runs.ts:90
modelHistory: history.messages.map((m) => ({ content: uiMessageText(m) }))
```

`uiMessageText` 只取 text part。工具入参与输出被丢掉 → 传给 `calculateMemoryContextTokenBudget` 的历史 token 系统性偏低 → 记忆注入预算算得偏大。`token-estimator.ts` 里那个 legacy `estimateHistoryTokens(readonly {content}[])` 就是为了迁就这个适配器才留着的。

---

## 2. 目标设计

### 2.1 派生状态：三态，不为不存在的概念留字段

```ts
// services/session-status.ts
export type SessionStatus = "requires_action" | "running" | "idle";

export interface SessionStatusFacts {
  readonly hasPendingApproval: boolean;
  readonly hasRunningRun: boolean;
}

/**
 * 会话状态是**算出来的**，不是存的（docs 14 §5.2 原则 8）。
 * 优先级取首个命中：等人 > 在跑 > 空闲。
 *
 * docs 14 还列了第四态 `waiting`（主 loop 闲但有存活后台任务）。后台任务是 S7
 * 的概念，现在不存在 —— 不为不存在的概念留字段，S7 引入 background_tasks 时再加。
 */
export const deriveSessionStatus = (facts: SessionStatusFacts): SessionStatus =>
  facts.hasPendingApproval ? "requires_action"
    : facts.hasRunningRun ? "running"
      : "idle";
```

纯函数，可单测，不认识 DB。查事实的活由一个薄读取器做。

### 2.2 两个读接口

```
GET /api/v1/threads/:id/status
  → { status, activeRunId: string | null, pendingApprovals: [{ callId, toolName, args }] }

GET /api/v1/threads/:id/usage
  → {
      contextTokens: number,               // 当前模型可见历史（含摘要）的估算
      contextWindow: number | null,        // chat 槽位模型的窗口；未知则 null
      contextRatio: number | null,         // contextTokens / contextWindow
      runCount: number,
      totalUsage: StreamTokenUsage,        // 该会话所有 run 的用量累加
      lastRun: { id, status, finishReason, endedAt } | null
    }
```

`ThreadSummary` 增加 `status: SessionStatus` —— 侧栏一次拉列表就能画状态点，不用 N 个请求。

### 2.3 摘要生成器**注入**给 compact

`compact.ts` 是数据层，不该认识模型。所以：

```ts
export type SummarizeMessages = (
  messages: readonly StoredMessage[],
  previousSummary: string | undefined
) => Promise<string>;

export interface CompactOptions {
  readonly sessionId: string;
  readonly keepRecentMessages?: number;
  readonly trigger?: string;
  /** 缺省用确定性拼接。注入而非内建 —— compact 不认识模型，只认识"给我一段摘要"。 */
  readonly summarize?: SummarizeMessages;
}
```

LLM 版实现单独一个文件 `services/summarize-with-model.ts`，`compactSession` 里 try/catch，失败回落确定性拼接并 `logger.warn`。**摘要失败绝不能挡住 run。**

---

## 3. 涉及文件

### 新增
| 文件 | 内容 |
|---|---|
| `apps/server/src/services/session-status.ts` | `deriveSessionStatus` + `readSessionRuntimeStatus` |
| `apps/server/src/services/session-usage.ts` | `readSessionUsage`（聚合 runs + 历史估算） |
| `apps/server/src/services/summarize-with-model.ts` | `createModelSummarizer` |
| `apps/web/src/features/threads/components/context-usage.tsx` | 上下文占用条 + 累计 token |
| `apps/web/src/features/threads/components/session-status-dot.tsx` | 状态点 |
| `tests/session-status.test.ts` | 派生逻辑 + 读接口 |
| `tests/session-usage.test.ts` | 用量聚合 |
| `tests/compact-summarizer.test.ts` | LLM 摘要 + 回落 |

### 修改
| 文件 | 动作 |
|---|---|
| `apps/server/src/db/repositories/run-repository.ts` | 加 `findRunningBySessionId` / `listRunningSessionIds` / `sumUsageBySessionId` / `findLastBySessionId` |
| `apps/server/src/services/compact.ts` | `compactSession` 变 async + 接 `summarize` 注入 + 现有拼接改名 `composeDeterministicSummary` |
| `apps/server/src/services/auto-compact.ts` | 变 async，透传 `summarize` |
| `apps/server/src/routes/runs.ts` | `await autoCompactIfNeeded(...)`；记忆预算改传 `historyTokens` |
| `apps/server/src/routes/threads.ts` | 两个新路由 + `ThreadSummary.status` |
| `apps/server/src/services/memory-runtime.ts` | `modelHistory` → `historyTokens: number` |
| `apps/server/src/services/memory-recall.ts` | `CalculateMemoryContextBudgetOptions.modelHistory` → `historyTokens` |
| `apps/server/src/services/token-estimator.ts` | **删** legacy `estimateHistoryTokens` |
| `packages/shared/src/index.ts` | `SessionStatus` / `ThreadStatus` / `ThreadUsage` 契约 + `ThreadSummary.status` |
| `apps/web/src/features/threads/components/{sidebar,chat-view}.tsx` | 挂状态点与用量条 |
| `apps/web/src/features/threads/api.ts` | 两个新 API |

---

## 4. 步骤

### Step 1 · 【测试先行】派生状态

`tests/session-status.test.ts` 先测纯函数（8 行代码，4 个用例：两个 true 时取 requires_action；只有 run 在跑取 running；都没有取 idle；审批优先级高于 run）。

`services/session-status.ts`：

```ts
import type { SessionStatus } from "@eva/shared";

import type { AppDatabase } from "../db/index.js";
import { DrizzleRunRepository } from "../db/repositories/run-repository.js";
import type { ApprovalGateway } from "./approval-gateway.js";

// ... deriveSessionStatus（见 §2.1）

export interface PendingApprovalView {
  readonly callId: string;
  readonly toolName: string;
  readonly args: unknown;
}

export interface SessionRuntimeStatus {
  readonly status: SessionStatus;
  readonly activeRunId: string | null;
  readonly pendingApprovals: readonly PendingApprovalView[];
}

/** 查事实 → 派生状态。事实来源：runs 表（持久）+ 审批网关（进程内存）。 */
export const readSessionRuntimeStatus = (
  db: AppDatabase,
  approvals: ApprovalGateway,
  sessionId: string
): SessionRuntimeStatus => {
  const activeRun = new DrizzleRunRepository(db).findRunningBySessionId(sessionId);
  const pending = approvals.listPending(sessionId);

  return {
    status: deriveSessionStatus({
      hasPendingApproval: pending.length > 0,
      hasRunningRun: activeRun !== undefined
    }),
    activeRunId: activeRun?.id ?? null,
    pendingApprovals: pending.map((p) => ({
      callId: p.callId,
      toolName: p.tool,
      args: p.args
    }))
  };
};
```

> `ApprovalGateway.listPending` 返回的字段叫 `tool`；这里映射成 `toolName` 与 SSE 事件的命名对齐（`RunApprovalRequestEvent.toolName`）。**同一个概念在对外契约里只能有一个名字。** 顺手把 `listPending` 的返回字段也改成 `toolName`，两边一致。

### Step 2 · `RunRepository` 补四个查询

```ts
/** 该会话正在飞的 run（正常只会有 0 或 1 条）。 */
findRunningBySessionId(sessionId: string): RunRecord | undefined

/** 所有有 run 在飞的会话 id —— 侧栏列表一次查完，避免 N+1。 */
listRunningSessionIds(): readonly string[]

/** 该会话所有 run 的 usage 累加（null usage 跳过）。 */
sumUsageBySessionId(sessionId: string): { readonly usage: StreamTokenUsage; readonly runCount: number }

findLastBySessionId(sessionId: string): RunRecord | undefined
```

`sumUsageBySessionId` 在 SQL 里 `SELECT usage FROM runs WHERE session_id = ?` 后在 JS 里累加（usage 是 JSON 列，不值得为它建 JSON1 表达式索引）。

### Step 3 · 用量读取器

`services/session-usage.ts`：

```ts
export interface SessionUsage {
  readonly contextTokens: number;
  readonly contextWindow: number | null;
  readonly contextRatio: number | null;
  readonly runCount: number;
  readonly totalUsage: StreamTokenUsage;
  readonly lastRun: {
    readonly id: string;
    readonly status: RunStatus;
    readonly finishReason: string | null;
    readonly endedAt: string | null;
  } | null;
}

/**
 * 上下文占用 = 模型这一轮实际会看到的历史（含 compaction 摘要）的估算，
 * 不是 messages 表的全量 —— 用户关心的是"离下一次 compact 还有多远"。
 */
export const readSessionUsage = (
  db: AppDatabase,
  session: SessionService,
  sessionId: string
): SessionUsage => {
  const history = session.buildModelHistory(db, sessionId);
  const contextTokens = estimateModelHistoryTokens(history);
  const chat = resolveModelSlot(db, "chat");
  const contextWindow = chat.ok ? chat.binding.contextWindow ?? null : null;
  // ...
};
```

### Step 4 · 两个路由 + `ThreadSummary.status`

`routes/threads.ts`：

```ts
app.get("/api/v1/threads/:id/status", async (request, reply): Promise<ThreadStatus | { error: string }> => {
  // 404 if thread not found
  return readSessionRuntimeStatus(app.infra.db, app.services.approvals, id);
});

app.get("/api/v1/threads/:id/usage", async (request, reply): Promise<ThreadUsage | { error: string }> => {
  // 404 if thread not found
  return readSessionUsage(app.infra.db, app.services.session, id);
});
```

`listThreadSummaries` 改造（一次查完，不要 N+1）：

```ts
const runningSessionIds = new Set(new DrizzleRunRepository(app.infra.db).listRunningSessionIds());

return sessionRepo.listAll(limit).map((thread) => ({
  // ... 现有字段
  status: deriveSessionStatus({
    hasPendingApproval: app.services.approvals.listPending(thread.id).length > 0,
    hasRunningRun: runningSessionIds.has(thread.id)
  })
}));
```

> `listPending(sessionId)` 现在是遍历内存 Map。会话数上百时这是 O(threads × pending)，但 pending 数量正常是 0–2，可以接受。若 FINDINGS 里出现性能反馈，再给 gateway 加一个 `sessionId → count` 索引。

`packages/shared/src/index.ts` 加契约：`SessionStatus`、`ThreadStatus`、`ThreadUsage`，`ThreadSummary` 加 `status: SessionStatus`。

**【测试先行】`tests/session-usage.test.ts`**：造两条 settled run（带 usage）+ 一条 running → `runCount === 3`、`totalUsage` 是两条的和、`status` 为 running；`contextWindow` 在 chat 槽位不可解析时为 null（不抛）。

### Step 5 · LLM 摘要

**5.1** `services/compact.ts`：
- 现有 `generateSummaryText` 改名 `composeDeterministicSummary`，**保留**（回落路径）；
- `compactSession` 签名变 `async`，`CompactOptions` 加 `summarize?: SummarizeMessages`；
- 摘要生成处：

```ts
const summary = await resolveSummary(messagesToSummarize, existingSummary, options.summarize);

// ---
/** 有注入的 summarizer 就用它；抛错就回落确定性拼接 —— 摘要质量可以降级，run 不能挂。 */
const resolveSummary = async (
  messages: readonly StoredMessage[],
  previousSummary: string | undefined,
  summarize: SummarizeMessages | undefined
): Promise<string> => {
  if (!summarize) {
    return composeDeterministicSummary(messages, previousSummary);
  }

  try {
    const text = (await summarize(messages, previousSummary)).trim();
    return text || composeDeterministicSummary(messages, previousSummary);
  } catch {
    return composeDeterministicSummary(messages, previousSummary);
  }
};
```

> 回落时**不要**在这里 `logger.warn` —— compact.ts 没有 logger，硬塞一个会让它认识日志设施。改为让 `createModelSummarizer` 自己在抛出前 warn（它有 logger）。

**5.2** `services/summarize-with-model.ts`：

```ts
import { generateText } from "ai";

/** 摘要要覆盖的三件事 —— 少了任何一件，压缩后的会话就"失忆"。 */
const SUMMARY_INSTRUCTIONS = [
  "You are compacting an agent conversation so it can continue with less context.",
  "Write a summary that preserves:",
  "1. What the user asked for and any constraints they stated;",
  "2. What was actually done — files changed, commands run, findings, with concrete names;",
  "3. What is still open — unfinished steps, unresolved questions, known failures.",
  "",
  "Be specific over brief: keep file paths, identifiers and error messages verbatim.",
  "Do not add commentary about the summary itself. Output plain text, no preamble."
].join("\n");

/**
 * 用 tool 槽位模型生成压缩摘要（docs 14 §4.3）。
 * 抛错即代表"这次摘要没做成"，由 compactSession 回落到确定性拼接。
 */
export const createModelSummarizer = (
  binding: ModelBinding,
  logger: Logger
): SummarizeMessages => async (messages, previousSummary) => {
  const transcript = messages
    .map((m) => `[${m.message.role}] ${summarizeParts(m.message)}`)
    .join("\n\n");

  try {
    const { text } = await generateText({
      model: toAgentModel(binding),
      instructions: SUMMARY_INSTRUCTIONS,
      prompt: previousSummary
        ? `Previous summary:\n${previousSummary}\n\nNew messages to fold in:\n${transcript}`
        : transcript,
      maxOutputTokens: 1200,
      temperature: 0
    });

    return text;
  } catch (error) {
    logger.warn({ err: error, model: binding.qualifiedModelId }, "LLM 摘要失败，回落确定性拼接");
    throw error;
  }
};
```

`summarizeParts` 把 UIMessage parts 铺成文本（text 原样、dynamic-tool 写成 `tool <name>(input) → output 前 N 字`）。工具轨迹**必须进摘要输入**，否则摘要不知道 agent 干了什么。

**5.3** `auto-compact.ts` 的 `autoCompactIfNeeded` 变 async 并透传 `summarize`。

**5.4** `routes/runs.ts` 的 `prepareRun`：

```ts
const models = /* 已由路由解析并传入 */;
await autoCompactIfNeeded(app.infra.db, session.id, createAutoCompactConfig(settings.chat), {
  summarize: createModelSummarizer(models.tool, app.log)
});
```

`POST /api/v1/threads/:id/compact`（手动压缩）同样接上 summarizer。

**【测试先行】`tests/compact-summarizer.test.ts`**：
- 注入一个返回固定文本的 summarize → `session_compactions.summary` 就是它；
- 注入一个抛错的 summarize → 落库的是确定性拼接（**不抛出**）；
- 注入返回空串的 summarize → 也回落；
- `summarizeParts` 覆盖工具 part（断言摘要输入里含工具名与输出片段）。

### Step 6 · 记忆预算改传 token 数

- `memory-recall.ts`：`CalculateMemoryContextBudgetOptions.modelHistory` → `readonly historyTokens: number`，内部 `estimateHistoryTokens(options.modelHistory)` 换成直接用 `options.historyTokens`。
- `memory-runtime.ts`：`BuildMemoryRuntimeSupportOptions.modelHistory` → `readonly historyTokens: number`。
- `routes/runs.ts`：`historyTokens: estimateModelHistoryTokens(history)`（工具轨迹计入）。
- `token-estimator.ts`：**删除** `estimateHistoryTokens` 与 `estimateHistoryTokens` 的唯一存在理由。

### Step 7 · 前端

**7.1 `session-status-dot.tsx`**：一个 6px 圆点。`running` = 蓝色 + `animate-pulse`；`requires_action` = 橙色（实心，不动 —— 它需要人操作，闪烁反而让人焦虑）；`idle` = 不渲染。挂在 `sidebar.tsx` 的会话标题左侧。数据来自 `ThreadSummary.status`（列表接口已带）。

**7.2 `context-usage.tsx`**：一条细进度条 + `12.4k / 200k` 文案 + hover tooltip 展示 `totalUsage`。挂在 `chat-view.tsx` 顶部（`ChatInput` 上方或标题栏右侧）。

```ts
const usage = useQuery({
  queryKey: ["thread-usage", sessionId],
  queryFn: () => fetchThreadUsage(sessionId!),
  enabled: sessionId !== null,
  staleTime: 10_000
});
```

**7.3 失效时机**：`use-chat.ts` 在 SSE `end` 帧到达后 `invalidateQueries({ queryKey: ["thread-usage", sessionId] })` 与 `["threads"]`。**不要**在流式中途轮询用量 —— 一轮结束再刷一次就够，中途刷只会给 SQLite 加无谓压力。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；3 个新测试文件从 RED 到 GREEN
- [ ] `grep -rn "estimateHistoryTokens" apps` 无结果
- [ ] `grep -rn "generateSummaryText" apps` 无结果（已改名 `composeDeterministicSummary`）
- [ ] `curl /api/v1/threads/<id>/status` 在空闲会话返回 `idle`；发消息期间返回 `running`；审批弹出期间返回 `requires_action`
- [ ] `curl /api/v1/threads/<id>/usage` 的 `contextTokens` 随对话增长；`totalUsage.totalTokens` 等于各 run usage 之和
- [ ] 手工：侧栏在另一个会话跑着时显示蓝点；审批挂起时显示橙点
- [ ] 手工：聊天页顶部能看到上下文占用比，一轮结束后数字更新
- [ ] 手工：把 tool 槽位指向一个可用模型 → 触发 compact → `session_compactions.summary` 是通顺的自然语言（不是 `[tool] ...` 拼接）
- [ ] 手工：把 tool 槽位指向一个错误 API key → 触发 compact → 摘要回落为确定性拼接，**run 正常完成**，日志有 warn

## 6. 坑

1. **`compactSession` 变 async 会波及调用链**：`autoCompactIfNeeded` → `prepareRun` → 路由。`prepareRun` 已是 async，路由已 await，链路是通的；但 `POST /threads/:id/compact` 与测试里的同步调用要一起改。用 `pnpm typecheck` 找断点。
2. **摘要的 prompt 里要放工具轨迹**，但工具输出可能极长。`summarizeParts` 必须对每个 part 的输出截断（建议 500 字/条），否则摘要请求自己就超上下文了 —— 这正是要压缩的原因。
3. **`temperature: 0` + `maxOutputTokens: 1200`** 是摘要场景的合理默认，理由写进注释（摘要要稳定可复现，不要发散）。
4. **状态点不要用轮询实现**。`ThreadSummary.status` 随列表接口来，列表本身在 run 结束时 invalidate 一次。给侧栏加 `refetchInterval` 会让空闲的 Eva 每秒打一次 DB。
5. **`waiting` 态别提前加**。S7 引入 `background_tasks` 表时，`SessionStatusFacts` 加一个 `hasLiveBackgroundTask` 字段、`deriveSessionStatus` 加一行即可 —— 这就是纯函数派生的回报。
