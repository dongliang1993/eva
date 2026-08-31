# T15 · 子代理 fork-join（S7）

> 前置：无。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §3。
> 施工图：`docs/architecture/08-parallel-multi-agent.md` 全篇（尤其 §3 fork-join、§6 四道成本阀、§7 最小内核、§8 三个"不做"）、`14-eva-architecture.md` §4.5。

**建议拆 4 个 commit**：`feat(harness)` 原语与角色注册表 → `feat(data)` 表与消息树 → `feat(server)` 接线与路由 → `feat(web)` 子代理视图。前三个 commit 完成后功能已可用（工具结果文本可见），第四个是可观测性。

---

## 1. 为什么现在做

Eva 的工具集是 9 个本地工具 + MCP，**没有子代理**（`grep -rl "subagent\|Task(" apps packages` → 0；R1 T4 摘掉半成品后未重建）。真实任务上撞到的第一面墙是上下文耗尽，而现有两个缓解手段都是有损的：compact 必然丢细节，tool-overflow 要模型多花一轮续读。

缺的是**上下文隔离**：`docs 08 §6.2` —— 子代理跑 30 步读 20 个文件，主 agent 只拿最后一段结论。主上下文预算随"结论"线性增长，而不是随"工作量"爆炸增长。

---

## 2. 目标设计

### 2.1 一条 loop，两个原语

`docs 08 §8` 的三个"不做"是本任务的宪法：

1. **不自造并发原语**（无 p-limit / semaphore）—— fan-out 给 SDK，调度决策给 LLM；
2. **不为子代理写第二套引擎** —— 子代理 = 递归调用同一个 `createAgent` + 换 system prompt + 换便宜模型；
3. **不把编排模式写进主循环** —— 主循环只认识 `Task` / `TaskOutput`。

```
Task 工具（fork）                        TaskOutput 工具（join）
  ├─ subagentType   选角色（查 crew 注册表）    ├─ taskId
  ├─ prompt         任务书                      └─ block  true=等结果 / false=看一眼
  ├─ description    3-5 词，给日志与 UI 用
  ├─ runInBackground  默认 false（前台）
  └─ resume         taskId，带 transcript 续聊
```

**默认前台**。引导文案照抄 `docs 08 §3.1` 实证原文：

> "Prefer foreground execution so the user can watch the agent's progress stream inline. Use run_in_background only when concurrency matters more than live visibility."

前台子代理的中间过程实时流给用户（§2.5 的事件通道），后台的静默。`docs 08 §6.4`：**可见性不只是 UX，是成本熔断器** —— 后台跑偏没人看见，直到 join 才发现烧了几万 token。

### 2.2 角色注册表（crew）

```ts
// packages/harness/src/subagents/crew.ts
export interface SubagentRole {
  readonly type: string;
  /** 一句话，进 Task 工具的 description 让模型知道什么时候选它。 */
  readonly summary: string;
  readonly systemPrompt: string;
  /** 该角色能拿到的工具名白名单。空数组 = 不给任何工具（纯推理角色）。 */
  readonly allowedTools: readonly string[];
  /** 能再委派给哪些角色。空数组 = 拿不到 Task 工具，无法套娃。 */
  readonly allowedDelegates: readonly string[];
  readonly maxSteps?: number;
}
```

首批三个角色（都是"只给结论"型，正好是上下文隔离最划算的场景）：

| type | 用途 | allowedTools | allowedDelegates |
|---|---|---|---|
| `explorer` | 读代码库回答"在哪 / 怎么实现的" | `read_file` `list_dir` `grep` `read_skill` | — |
| `researcher` | 查外部资料 | `web_search` `web_fetch` `read_file` | — |
| `reviewer` | 挑毛病，不给实现 | `read_file` `list_dir` `grep` | `explorer` |

`reviewer → explorer` 这条委派边不是摆设：它让深度闸有真实验收对象（主=0 → reviewer=1 → explorer=2 = `MAX_DEPTH`，explorer 拿不到 Task）。

**三个角色都不含写工具**（`write` / `edit` / `bash`）—— 这是四道阀的第四道，见 §2.6。

### 2.3 任务表：只存事实，不存第二份 transcript

```ts
export interface TaskRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  readonly depth: number;
  readonly status: "running" | "done" | "failed";
  readonly result: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
```

> **偏离 `docs 14 §7.2`**：那里规划了 `background_tasks.transcript` 列。本方案**不存 transcript**
> —— 子代理消息已经以 UIMessage 整存进 `messages` 表（§2.4），resume 直接从消息子树用
> `convertToModelMessages` 重建即可。存第二份 transcript 就是同一事实两个来源，
> 而这个仓库前三轮一直在干的事就是消灭这种重复。

Store 接口在 harness（机制），SQLite 实现在 server（持久化）：

```ts
// packages/harness/src/subagents/task-store.ts
export interface TaskStore {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  settle(taskId: string, outcome: { result?: string; error?: string }): Promise<void>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  /** 等到终态或超时。超时返回当前记录（status 仍为 running）—— 由调用方决定给模型 partial 还是继续等。 */
  waitFor(taskId: string, timeoutMs: number): Promise<TaskRecord | undefined>;
}
```

`InMemoryTaskStore`（harness 自带，供测试与无 DB 场景）+ `SqliteTaskStore`（server）。
后者用 **DB 记录事实 + 进程内 deferred 做通知**：后台任务的 loop 本来就在内存里，
`waitFor` 没必要轮询数据库。

### 2.4 子代理消息树：与主链共表，靠一列隔离

`messages` 表加 `parent_tool_call_id`（`docs 14 §7.2` 早就规划了，R1 T1 没做）：

```
messages
  parent_tool_call_id = NULL   → 主对话链（T12 的 buildActiveChain 走这些）
  parent_tool_call_id = <id>   → 某次 Task 调用的子代理消息子树
```

每次子代理运行落 **两条**消息（读起来像一段对话）：

1. `role: "user"` = 任务书（Task 的 `prompt`）
2. `role: "assistant"` = 子代理这一轮的完整 UIMessage（text / tool 调用 / step-start 全在 parts 里）

子树内部用 `parent_id` 串起来；`resume` 时把整个子树按 `parent_id` 排好交给 `convertToModelMessages`。

> **🔴 这是本任务唯一的静默失败模式。** `buildActiveChain`（`services/message-tree.ts`）现在拿到
> `findBySessionId` 的全部行。子代理消息一进表，如果不过滤，它们就会被串进主对话链 ——
> **模型会在主上下文里看到子代理的全部中间过程，把 T15 想省的上下文反向炸掉，而且不报错。**
> 规则：`buildActiveChain` 与 `GET /threads/:id/messages` 一律只认 `parentToolCallId === null`。
> Step 顺序据此排（§4 Step 3 先于 Step 5）。

### 2.5 事件通道：ctx 信封在唯一入口注入

```ts
// packages/harness/src/subagents/types.ts
export interface SubagentEvent {
  readonly taskId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  /** 子代理内部的流事件 —— 与主线程同一套 AI SDK 命名，不另造一套。 */
  readonly event: AgentStreamEvent;
}

export type SubagentEventSink = (event: SubagentEvent) => void;
```

`docs 14 §4.5` 的教训：ctx 信封（谁的子代理、挂在哪个 tool call 上）**必须收敛到一个 emit 入口强制注入**，
不能靠每个产生事件的地方手工带上。本方案里那个唯一入口是 `runSubagent` 转发事件的那个 for 循环 ——
调用方永远拿不到"没有信封"的子代理事件。

server 侧的 sink 做两件事：① `emit({ type: "subagent_update", ... })` 推 SSE；
② 喂一个 per-task 的 `UiMessageBuilder`，子代理 `finish` 时落库（§2.4）。

`packages/shared/src/stream-events.ts` 加：

```ts
/** 子代理域事件（Eva 自有域，与 SDK 命名空间隔离）。 */
export interface RunSubagentUpdateEvent {
  type: "subagent_update";
  taskId: string;
  parentToolCallId: string;
  subagentType: string;
  event: RunAgentStreamEvent;
}
```

### 2.6 四道成本阀（每道都要有测试钉住）

`docs 08 §6`：多 agent 翻车几乎全部因为钱烧穿或上下文炸，不是逻辑错。

| # | 阀门 | 实现 | 测试断言 |
|---|---|---|---|
| 1 | **子代理用便宜模型** | Task 工具注入的是 `ResolvedModels.tool`（R2 T7 建好的槽位，缺省回落 chat） | 断言 `runSubagent` 收到的 model 是 tool 槽位那个实例 |
| 2 | **final answer 唯一出口** | Task 的 execute 只返回 `result.text`；中间过程只走 sink | 子代理调了 3 个工具 → 工具返回串里**不含**任何中间工具输出 |
| 3 | **深度闸 + 委派白名单** | `MAX_DEPTH = 2`；`depth + 1 > MAX_DEPTH` 或 `type ∉ crew[current].allowedDelegates` → 直接返回错误文本 | depth 超限被拒；不在白名单的 type 被拒 |
| 4 | **工具集收窄** | 每个角色的 `allowedTools` 白名单过滤；首批三个角色**都不含写工具** | `explorer` 的工具集里没有 `write` / `edit` / `bash` |

> **第 4 道偏离 `docs 08 §2.1`**：那里的做法是子代理关掉 `parallelToolCalls`（Alma 的 `Lt` 闸门）。
> **`ai@7` 没有暴露这个参数**（`grep -c parallelToolCalls node_modules/ai/dist/index.d.ts` → 0，
> `@ai-sdk/openai-compatible` 同样为 0），它是 OpenAI 系的 provider 私有参数。
> 与其去挖 `providerOptions` 里的 provider 特有开关（还只对一部分 provider 有效），
> **按角色收窄工具集是更强的保证**：没有写工具，就不存在并发写冲突。别去追那个参数。

### 2.7 abort 语义：后台子代理随 run 一起中止

> **偏离 `docs 14 §4.2`**（"abort 只停主 loop，不杀后台子代理"）。

理由：`session.status` 的 `waiting` 态（"主 loop 闲但有存活后台任务"）在 R2 T8 被**明确推迟**了
（T8 §2.1：不为不存在的概念留字段）。没有 `waiting`，一个活过 run 的后台子代理就是
**没有观察者、结果无人认领、token 无声烧掉** —— 正是 `docs 08 §6.4` 说的那种不可见消耗。

所以本方案：后台子代理共享 run 的 `AbortSignal`，用户点停止就全停。
等 R5 做 `waiting` 态与后台任务的跨 run 生命周期时，再把这条改回来（届时 `docs 14 §4.2` 才成立）。

---

## 3. 涉及文件

### 新增
| 文件 | 内容 |
|---|---|
| `packages/harness/src/subagents/crew.ts` | `SubagentRole` + 内置三角色 + `CrewRegistry` |
| `packages/harness/src/subagents/task-store.ts` | `TaskStore` 接口 + `InMemoryTaskStore` |
| `packages/harness/src/subagents/run-subagent.ts` | 递归跑一次 loop（前后台共用），唯一的事件信封注入点 |
| `packages/harness/src/subagents/task-tools.ts` | `createTaskTools()` → `[Task, TaskOutput]` |
| `packages/harness/src/subagents/{types,index}.ts` | 类型 + re-export |
| `apps/server/src/db/migrations/0021_subagents.sql` | `background_tasks` 表 + `messages.parent_tool_call_id` |
| `apps/server/src/db/repositories/task-repository.ts` | `background_tasks` CRUD |
| `apps/server/src/services/subagents/sqlite-task-store.ts` | `TaskStore` 的 SQLite 实现（DB 记事实 + 内存 deferred 做通知） |
| `apps/server/src/services/subagents/subagent-recorder.ts` | sink：推 SSE + per-task `UiMessageBuilder` 落库 |
| `apps/server/src/services/subagents/index.ts` | re-export |
| `skills/parallel-research/SKILL.md` → 装进 `~/.eva/skills/` | **一个**示例编排 skill（验收"新增编排 = 写 markdown"） |
| `tests/subagent-crew.test.ts` | 角色过滤 / 委派白名单 / 深度闸（纯函数） |
| `tests/subagent-tools.test.ts` | Task 前台/后台、TaskOutput join/超时、异常不吞、final answer 唯一出口 |
| `tests/subagent-messages.test.ts` | 消息树落库 + **主链不被污染** |

### 修改
| 文件 | 动作 |
|---|---|
| `packages/harness/src/index.ts` | 导出 subagents |
| `packages/harness/src/agents/types.ts` | `CreateAgentOptions` 无需变（Task 工具通过 `tools` 传入） |
| `packages/shared/src/stream-events.ts` | `RunSubagentUpdateEvent` + 并入 `RunStreamEvent` |
| `packages/shared/src/index.ts` | `SubagentMessage`（`/subagent-messages` 的返回契约） |
| `apps/server/src/db/schema.ts` | `backgroundTasks` 表 + `messages.parentToolCallId` |
| `apps/server/src/db/repositories/types.ts` | `StoredMessage.parentToolCallId` + `CreateMessageInput.parentToolCallId?` |
| `apps/server/src/db/repositories/message-repository.ts` | 落库/读取带上新列；加 `findBySubagentToolCallId` |
| `apps/server/src/services/message-tree.ts` | **`buildActiveChain` 过滤 `parentToolCallId !== null`** |
| `apps/server/src/services/session.ts` | 新增 `recordSubagentMessages` |
| `apps/server/src/agent.ts` | `ConfiguredAgentOptions` 增 `subagents?`；注入 Task 工具 |
| `apps/server/src/services/agent-factory.ts` | 把 tool 槽位模型 + store + sink 传进 Task 工具 |
| `apps/server/src/routes/runs.ts` | 构造 sink（emit + recorder）；后台任务共享 `AbortSignal` |
| `apps/server/src/routes/threads.ts` | `GET /threads/:id/subagent-messages`；messages 路由过滤主链 |
| `apps/server/src/deps.ts` | 启动时把上次遗留的 `running` 任务收成 `failed`（照 `runs.failStale()`） |
| `apps/web/src/features/threads/components/tool-call-block.tsx` | `Task` 调用渲染成子代理卡片（类型 + 状态 + 可展开过程） |
| `apps/web/src/features/threads/hooks/use-chat.ts` | 消费 `subagent_update` |

---

## 4. 步骤

### Step 1 · 【测试先行】crew 注册表与三道纯逻辑阀

`tests/subagent-crew.test.ts`：`allowedTools` 过滤（`explorer` 拿不到 `write`/`edit`/`bash`）；
`allowedDelegates` 拒绝不在白名单的 type；`depth + 1 > MAX_DEPTH` 被拒；未知 type 返回可读错误。

然后写 `crew.ts`。**常量必须注释取值理由**：`MAX_DEPTH = 2`（主=0 → 一层专家 → 一层助手；
再深就该拆任务而不是套娃）、`JOIN_TIMEOUT_MS`、`SUBAGENT_MAX_STEPS`。

### Step 2 · 【测试先行】`runSubagent` + Task/TaskOutput

`run-subagent.ts` 是递归点，也是**事件信封的唯一注入处**：

```ts
export const runSubagent = async (input: RunSubagentInput): Promise<SubagentOutcome> => {
  const role = input.crew.get(input.subagentType);   // 未知 type → 抛
  const agent = createAgent({
    model: input.model,                              // 阀1：tool 槽位模型
    tools: filterTools(input.tools, role.allowedTools, input.depth, input.crew),
    systemPrompt: role.systemPrompt,
    maxSteps: role.maxSteps ?? SUBAGENT_MAX_STEPS,
    ...(input.observer !== undefined ? { observer: input.observer } : {})
  });

  let text = "";
  for await (const event of agent.stream({ messages: input.messages, abortSignal: input.abortSignal })) {
    // ★ 信封在这里注入 —— 调用方永远拿不到裸事件
    input.onEvent?.({
      taskId: input.taskId,
      parentToolCallId: input.parentToolCallId,
      subagentType: input.subagentType,
      event
    });

    if (event.type === "finish") {
      text = event.text;
    }
  }

  return { text, /* ... */ };
};
```

`task-tools.ts` 的 `Task.execute`：

```
depth/白名单校验不过 → 返回错误文本（不抛，让模型自己看懂并改）
resume 给了但任务不存在 → 返回错误文本
messages = resume ? 从子树重建 : [{ role: "user", content: prompt }]
前台  → await runSubagent(...) → 返回 result.text（阀2：只有 final answer）
后台  → store.create(...) → 不 await 地跑，.then 写 done / .catch 写 failed+error（坑2）
        → 立即返回 { taskId, message: "Agent started in background. Use TaskOutput to read it." }
```

`TaskOutput.execute`：`block: false` → 返回当前 status；`block: true` → `store.waitFor(taskId, JOIN_TIMEOUT_MS)`，
超时返回 `status: "timeout"` + partial（坑3：**join 必须有超时，否则子代理死循环 = 主 agent 植物人**）。

`tests/subagent-tools.test.ts`（用 `MockLanguageModelV4`，照 `tests/lead-agent-loop.test.ts` 的搭法）：

- 前台 Task → 返回子代理的 final text；
- **阀2**：子代理调了工具 → Task 的返回串里不含任何中间工具输出；
- 后台 Task → 立即拿到 taskId；`TaskOutput(block:true)` 拿到结果；
- **坑2**：子代理抛错 → 任务记 `failed` + error，`TaskOutput` 立刻返回错误（不是永远 block）；
- **坑3**：子代理不结束 → `TaskOutput(block:true)` 在 `JOIN_TIMEOUT_MS` 后返回 timeout + partial；
- `resume` 不存在的 taskId → 可读错误文本。

### Step 3 · 数据层 + 主链过滤（**必须先于 Step 5**）

`0021_subagents.sql`：

```sql
ALTER TABLE `messages` ADD COLUMN `parent_tool_call_id` text;
--> statement-breakpoint
CREATE INDEX `idx_messages_parent_tool_call` ON `messages` (`parent_tool_call_id`);
--> statement-breakpoint
CREATE TABLE `background_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `parent_tool_call_id` text NOT NULL,
  `subagent_type` text NOT NULL,
  `depth` integer NOT NULL DEFAULT 1,
  `status` text NOT NULL DEFAULT 'running',
  `result` text,
  `error` text,
  `started_at` text NOT NULL DEFAULT (datetime('now')),
  `ended_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_background_tasks_session` ON `background_tasks` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_background_tasks_status` ON `background_tasks` (`status`);
```

journal 追加 `{ "idx": 21, "version": "6", "when": <now-ms>, "tag": "0021_subagents", "breakpoints": true }`。

**同一步里改 `buildActiveChain`**：只接受 `parentToolCallId === null` 的行。
`tests/subagent-messages.test.ts` 先加一条断言："表里有子代理消息时，主链长度不变"。
**这条断言必须在落库功能之前就绿**（先过滤，再往表里放东西）。

### Step 4 · server 侧 store 与 recorder

- `sqlite-task-store.ts`：`create/settle/get` 走 DB；`waitFor` 用进程内 `Map<taskId, Deferred>`
  （后台 loop 本来就在内存里，没必要轮询 DB）。进程重启后 deferred 全丢 —— 所以
  `deps.ts` 要照 `runs.failStale()` 的样子把遗留 `running` 收成 `failed`。
- `subagent-recorder.ts`：per-task 持一个 `UiMessageBuilder`；
  收到 `finish` 时把「任务书 user 消息 + 子代理 assistant 消息」两条落库，`parentToolCallId` 填上。

### Step 5 · 接线

- `agent.ts` 的 `ConfiguredAgentOptions` 加 `subagents?: { crew, store, model, onEvent, abortSignal }`；
  有它就把 `createTaskTools(...)` 的产物并进 tools。
- `agent-factory.ts`：`resolve()` 时把 `models.tool` 作为子代理模型传下去（阀1）。
- `routes/runs.ts`：构造 sink = `(e) => { emit({ type: "subagent_update", ...e }); recorder.push(e); }`；
  把 `controller.signal` 传给 subagents（§2.7）。
- `routes/threads.ts`：`GET /api/v1/threads/:id/subagent-messages?toolCallId=xxx`
  → 该子树的消息（按 `parent_id` 排好）；messages 路由确认已过滤主链。

### Step 6 · 前端子代理卡片

`tool-call-block.tsx` 对 `toolName === "task"` 特殊渲染：角色 + `description` + 状态点
（running / done / failed）+ 可展开区。展开区数据两个来源：流式中用 `subagent_update` 累积，
刷新后走 `/subagent-messages`。

**复用 `shared/streaming/` 与 `shared/markdown/`** —— 这正是 R1 T3 把三红线提到 `shared/` 的回报
（`docs 10 §6` 当时的理由就是"S7 子代理视图要复用"）。

### Step 7 · 一个编排 skill（验收"编排 = markdown"）

`~/.eva/skills/parallel-research/SKILL.md`，骨架照 `docs 08 §5.3`：
frontmatter 的 `description` 就是触发器；步骤里直接引用 `Task` / `TaskOutput` 原语；
带一条"红线"防模式退化。

**只写这一个。** council / gan-harness / rfc-DAG 是同一个机制的其它用法，
写第二个不增加对机制的验证（`docs 08 §8` 第三条）。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；三份新测试 RED→GREEN
- [ ] **阀1**：手工问一个需要委派的问题 → 服务端日志显示子代理用的是 tool 槽位模型，主 agent 用 chat 槽位
- [ ] **阀2**：子代理读了 5 个文件 → 主对话的上下文里只有它的结论（`/threads/:id/usage` 的 contextTokens 不随子代理工作量暴涨）
- [ ] **阀3**：让 `explorer` 再委派 → 被拒（它没有 Task 工具）；构造 depth=3 → 被拒
- [ ] **阀4**：`explorer` 试图写文件 → 它没有这个工具
- [ ] 手工：并行 fork 3 个后台子代理 → 立即拿到 3 个 taskId → 逐个 `TaskOutput(block:true)` join → 综合结论
- [ ] 手工：主对话里点开 Task 卡片 → 能看到子代理的完整过程（每一步 tool call / result）
- [ ] 手工：子代理跑一半点「停止」→ 子代理也停（§2.7），不留后台孤儿
- [ ] 手工：`resume` 同一个 taskId 追问 → 子代理带着上一轮记忆回答
- [ ] 手工：装 `parallel-research` skill → 问一个适合并行调研的问题 → agent 自己加载 skill 并按它编排
- [ ] **主链未污染**：`sqlite3 ~/.eva/eva.db "select count(*) from messages where parent_tool_call_id is not null"` > 0，
      同时前端主对话消息数与子代理消息数无关
- [ ] 重启进程 → 遗留的 `running` 任务变 `failed`（不是永远挂着）

## 6. 坑

按 `docs 08 §7` 的踩中概率排序（每条都在 §4 里有对应测试）：

1. **后台异常被吞** → join 方永远 block、线程假死。`.catch` 必须写 `status="failed"` + error 透出。
2. **join 无超时** → 子代理死循环时主 agent 植物人。`JOIN_TIMEOUT_MS` 硬上限 + 超时返回 partial。
3. **子代理消息污染主链** → 本任务最隐蔽的失败（不报错，只是上下文反向炸掉）。见 §2.4 与 Step 3 的顺序要求。
4. **无深度限制** → 递归委派炸弹。`MAX_DEPTH` + `allowedDelegates` 双闸。
5. **并行写同一文件** → 首批角色都不含写工具，物理上不存在。若将来给角色开写工具，
   必须同时给写工具加 per-path 互斥锁 —— 因为 `ai@7` 不暴露 `parallelToolCalls`（§2.6），
   没有"关掉并行"这个退路。
6. **别追 `parallelToolCalls`**。`grep -c parallelToolCalls node_modules/ai/dist/index.d.ts` → 0。
   在 `providerOptions` 里挖 provider 私有开关只对一部分 provider 有效，收益不抵复杂度。
7. **`Agent.invoke` 终于有生产调用方了**。R2 T10 保留它时注释写的就是"S7 的子代理会用它"——
   但本方案用的是 `stream()`（要转发事件给 sink）。做完后复核 `invoke` 是否仍无生产调用方，
   若是，在 FINDINGS 记一条，下一轮删掉它。
