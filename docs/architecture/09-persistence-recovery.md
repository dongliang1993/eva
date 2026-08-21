# 09 · 持久化与崩溃恢复：事件溯源，而不是快照

> 调研对象：Alma v0.0.960（Electron AI 桌面助手）
> 调研方法：静态挖掘 minified 主进程 bundle（`out/main/index.js`）+ 只读查询运行中的 SQLite schema
> 每条结论后标注【实证】；无法确证的标注【推测】。
> 前置阅读：03（后端与数据库总览）、04（模型适配与 agent harness）。本篇不重复其内容，只聚焦**持久化策略与崩溃恢复**。

---

## 1. 开篇：三种截然不同的答案

问"Alma 怎么做持久化和恢复"，得到的不是一个答案，而是三个截然不同的答案：

| 问题                             | Alma 的答案          | 机制                                                                                              |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| **Persistence**（状态存哪）      | ✅ 做满              | SQLite 全量落库，消息整条 JSON 存，token 用量逐轮落表                                             |
| **Checkpoint**（生成中逐步快照） | ❌ 明确不做          | bundle 全文 grep `checkpoint` **0 次命中**【实证】。没有 LangGraph 式的 step-level state snapshot |
| **Resume**（中断后恢复）         | 分三层，每层答案不同 | 断线重连 ✅ / 僵尸生成清理 ✅ / 崩溃续跑 ❌                                                       |

### 1.1 为什么是"事件溯源式恢复"而不是"快照式恢复"

```
快照式恢复（LangGraph 路线）          事件溯源式恢复（Alma 路线）
┌─────────────────────────┐        ┌─────────────────────────┐
│ 每个 step 存全量 state   │        │ 只存最终结果（消息）      │
│ checkpoint table         │        │ chat_messages           │
│ ├─ step 0: {state...}    │        │ ├─ msg 1 (user)         │
│ ├─ step 1: {state...}    │        │ ├─ msg 2 (assistant)    │
│ ├─ step 2: {state...}    │        │ └─ msg 3 (assistant)    │
│ 崩溃 → 从 step N 恢复    │        │ 崩溃 → 整轮作废，重新生成 │
│ 上下文精准接续            │        │ 上下文一致，只是慢了      │
└─────────────────────────┘        └─────────────────────────┘
```

Alma 选后者的原因，【推测】有三：

1. **重来成本低**。对话 agent 的单轮生成是"读消息历史 → 调 LLM → 写回消息"。崩溃后从消息历史重跑，**输入完全确定**，不需要中间状态。这跟 LangGraph 处理的多步有状态 agent（工具调用改变外部世界、不可逆）不是一类问题。
2. **实现简单**。不用维护 checkpoint schema、不用处理快照版本迁移、不用考虑"恢复到一半再崩"的递归问题。
3. **状态一致性好**。快照式恢复最怕的是"快照里的内存视图"和"DB 里的持久视图"不一致。事件溯源只有一种事实来源：DB 里的消息列表。永远一致。

**这是全套设计的地基：对话历史是唯一事实，内存里的一切都是可丢弃的投影。**

---

## 2. Single source of truth：SQLite 全量落库

### 2.1 `chat_messages` 完整 schema【实证】

```sql
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    parent_id TEXT,              -- 版本树：父消息指针
    slot_id TEXT,                -- 版本树：同一"槽位"的所有版本共享 slot_id
    depth INTEGER NOT NULL DEFAULT 0,  -- 在对话主干上的深度
    message TEXT NOT NULL,       -- 完整 UIMessage JSON（AI SDK 格式）
    timestamp TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    parent_tool_call_id TEXT,    -- 工具结果消息指向其 tool call
    FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_thread_id ON chat_messages(thread_id);
CREATE INDEX idx_messages_timestamp ON chat_messages(timestamp);
CREATE INDEX idx_messages_version_info ON chat_messages(thread_id, timestamp, id, slot_id, created_at);
CREATE INDEX idx_messages_parent_id ON chat_messages(parent_id);
CREATE INDEX idx_messages_slot_id ON chat_messages(slot_id);
CREATE INDEX idx_messages_depth ON chat_messages(depth);
CREATE UNIQUE INDEX idx_chat_messages_id ON chat_messages(id);
```

配套表：

```sql
CREATE TABLE chat_threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT,
    is_generating BOOLEAN DEFAULT FALSE,   -- 关键：生成状态的 DB 投影
    reasoning_effort TEXT DEFAULT 'medium',
    metadata TEXT NOT NULL,                -- JSON：含 activePath、savedTails
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
    -- ... 其他列（workspace / tools / favorite 等）从略
);

CREATE TABLE usage_records (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    model TEXT,
    provider_id TEXT,
    date TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_input_tokens INTEGER DEFAULT 0,
    cache_write_input_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
);

CREATE TABLE memory_sleep_runs (       -- 后台任务运行记录（启动清扫的对象）
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,              -- running / failed / completed
    trigger TEXT NOT NULL,
    examined INTEGER NOT NULL DEFAULT 0,
    -- ... 归档统计列从略
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
```

【实证】以上为 `sqlite3 -readonly chat_threads.db ".schema ..."` 原样输出（部分无关列裁剪）。

### 2.2 三个关键设计决策

**a. 消息整条 JSON 存，不拆字段。**
`message` 列存的是 AI SDK 的完整 `UIMessage` JSON（含 parts、tool invocations、annotations）。查询时整条读出、JSON.parse、直发前端。【实证】bundle 中 drizzle 定义：`message: he("message", {mode:"json"}).$type().notNull()`。

> **复刻要点**：不要试图把 UIMessage 拆成关系表。parts 数组里嵌套的 tool-call/tool-result 结构用关系模型表达极其痛苦，而且你几乎永远不需要按 part 内容做 SQL 查询（需要全文检索就挂 FTS5 虚表，Alma 有 `messages_fts`【实证】）。

**b. `onFinish` 时一次性 INSERT，不流式写。**
流式生成过程不落库；生成完成（或失败）的回调里才把完整消息写入。【实证】bundle 中 `addMessage` 在事务里做 insert，且失败路径会插入一条 `⚠️ Generation failed` 的提示消息（挂在当前 activePath 尾部，`metadata.turnEndReason = "error"`）。

> **推论**：如果你在前端刷新页面时看不到正在流式输出的半个回答——这是设计如此，不是 bug。崩了就是没了，重新生成。

**c. 用量逐轮落表，崩了也只丢当轮。**
`usage_records` 按 `message_id` 外键挂到消息上，每轮生成完成即写入 token 消耗。崩溃丢的是当轮用量，历史用量分毫不差。【实证】schema 如上。

---

## 3. 版本树：可回滚的对话历史（本篇最值钱的部分）

这是 Alma 持久化设计里最精巧的一块。它解决的问题是：**"重新生成"不应该覆盖旧答案，应该并存，且能随时切回。**

### 3.1 三字段语义【实证】

```
slot A          slot B          slot C
┌──────────┐    ┌──────────┐    ┌──────────┐
│ v1 ●─────┼───→│ v1 ●─────┼───→│ v1 ●──┐  │   ← activePath 走的分支
│ v2 ○     │    │          │    │ v2 ○  │  │   ← 被替换的旧版本还在表里
└──────────┘    └──────────┘    └───────┼──┘
                                        ↓
parent_id 指向前一个 slot 中"当时活跃"的那条消息
```

- **`parent_id`**：逻辑上的"上一条消息"。新版本挂在前驱 slot 的活跃版本之下。
- **`slot_id`**：**同一逻辑位置的所有版本共享同一个 slot_id**。一条消息首次创建时 `slot_id = 自己的 id`（【实证】bundle：`slotId: n?.slotId ?? o`，其中 `o` 是新消息 id）；regenerate 产生的新版本继承被替换消息的 `slot_id`。
- **`depth`**：消息在对话主干上的深度。`activePath` 数组的下标即 depth。

### 3.2 `activePath` 与 `savedTails`：当前分支存在 thread metadata 里【实证】

`chat_threads.metadata` JSON 里有两个关键字段：

- **`activePath: string[]`**——当前激活的消息 id 序列，即"用户现在看到的对话"。渲染时按 id 批量查回消息。
- **`savedTails: Record<string, string[]>`**——regenerate 时，被替换点**之后的整条尾部**被存进 `savedTails[replaceAtMessageId]`，不丢。切回旧版本时尾部可以恢复。

【实证】bundle 原文（minified 变量名已还原注释）：

```js
// addMessage 事务内：appendToActivePath 时把新消息 id push 进 activePath 并写回 metadata
if (opts?.appendToActivePath) {
  const meta = this.getThreadById(threadId).metadata || {};
  const path = Array.isArray(meta.activePath) ? [...meta.activePath] : [];
  path.push(newMessage.id);
  this.updateThread(threadId, { metadata: { ...meta, activePath: path } });
}

// beginReplaceAtSlot：截断 activePath，保存尾部
beginReplaceAtSlot(threadId, replaceAtMessageId) {
  const thread = this.getThreadById(threadId);
  const meta = thread.metadata || {};
  const path = Array.isArray(meta.activePath) ? [...meta.activePath] : [];
  const idx = path.indexOf(replaceAtMessageId);   // 被替换消息在 activePath 中的位置
  if (idx === -1) return { index: -1, activePath: path };
  const tail = path.slice(idx + 1);               // 被替换点之后的尾部
  const savedTails = { ...(meta.savedTails || {}) };
  savedTails[replaceAtMessageId] = tail;          // 尾部存起来，key = 被替换消息 id
  const truncated = path.slice(0, idx);           // activePath 截断到替换点之前
  this.updateThread(threadId, { metadata: { ...meta, activePath: truncated, savedTails } });
  return { index: idx, activePath: truncated };
}
```

**注意这个设计的不变量**：regenerate **不删任何行**。旧版本、旧尾部全部留在 `chat_messages` 表里，只是从 `activePath` 摘除。这就是"事件溯源"在对话树上的体现——表是只增的事实日志，`activePath` 只是一个视图指针。

### 3.3 渲染时的版本标注【实证】

读消息时 Alma 按 slot 分组统计版本数，给每条消息标注 `versionIndex / versionCount`（前端据此渲染 `‹ 2/3 ›` 切换器）：

```js
// bundle 实证逻辑还原
const versions = new Map() // slot -> [version...]（按 createdAt 升序）
for (const m of allMessagesInThread) {
  const slot = m.slotId || m.id
  if (!versions.has(slot)) versions.set(slot, [])
  versions.get(slot).push({ id: m.id, createdAt: m.createdAt })
}
for (const m of activeMessages) {
  const slot = m.slotId || m.id
  const vs = versions.get(slot) || [{ id: m.id, createdAt: m.createdAt }]
  m.metadata = {
    ...m.metadata,
    slotId: slot,
    depth: indexInActivePath,
    versionIndex: vs.findIndex((v) => v.id === m.id),
    versionCount: vs.length,
  }
}
```

【实证】bundle 中 `getMessageVersionInfoByThreadId` 查询：`SELECT id, slot_id, created_at FROM chat_messages WHERE thread_id=? ORDER BY timestamp ASC`——版本信息是一个廉价的投影查询，不需要 JOIN。

### 3.4 版本树操作复刻代码

四个核心操作（`createMessage` / `regenerate` / `listVersions` / `getActiveBranch` + 附赠 `selectVersion`）的完整实现见 **§7 复刻施工图**，那里是一个文件整合版，可直接搬进项目。这里只强调两个容易写错的点：

1. **regenerate 不写库时机**：生成失败就什么都不写，旧版本毫发无损。只有 LLM 返回完整结果后才进事务。【推测】这是 Alma 失败路径只插一条"⚠️ 提示"而不动树结构的原因。
2. **`slot_id ?? id` 兜底**：凡是新建消息，`slot_id` 缺省等于自己的 id；凡是替换消息，继承被替换者的 slot。这个规则一条都不能破，破了版本分组就散架。

---

## 4. 崩溃恢复三件套

Alma 的恢复不是"从快照续跑"，而是三件互相独立的小事，全部围绕"**内存投影与 DB 事实重新对齐**"。

### 4.a 启动清扫 healInterrupted()【实证】

后台记忆任务（MemorySleep）启动时做的第一件事：

```js
// bundle 实证原文（变量名还原）
healInterruptedSleepRuns() {
  if (!this.db) throw new Error("MemoryService not initialized");
  const now = new Date().toISOString();
  return this.db.update(sleepRuns)
    .set({ status: "failed", endedAt: now, error: "interrupted" })
    .where(eq(sleepRuns.status, "running"))
    .run().changes;
}
// 调用处（服务 start() 内）：
//   const n = svc.healInterruptedSleepRuns();
//   if (n > 0) console.log(`[MemorySleep] Marked ${n} interrupted run(s) as failed`);
```

原理：上次进程崩溃时，凡是 `status='running'` 的记录**一定是僵尸**——进程都死了，不可能还有任务在跑。启动时一次性标记为 `failed/interrupted`，历史记录干净，UI 不会永远显示"运行中"。

**泛化版**（复刻用，把 generations 也一起清扫）：

```ts
export function healInterrupted(db: Database.Database): void {
  const now = new Date().toISOString()
  const runs = db
    .prepare(
      `UPDATE memory_sleep_runs SET status='failed', ended_at=?, error='interrupted' WHERE status='running'`,
    )
    .run(now).changes
  // 关键：chat_threads.is_generating 也是 DB 投影，进程重启后全部归零
  const threads = db
    .prepare(`UPDATE chat_threads SET is_generating=0 WHERE is_generating=1`)
    .run().changes
  if (runs > 0)
    console.log(`[heal] Marked ${runs} interrupted run(s) as failed`)
  if (threads > 0)
    console.log(`[heal] Reset ${threads} stale is_generating flag(s)`)
}
```

> 【实证】Alma 对 `is_generating` 也有同思路的兜底：bundle 中存在 `Force-reset isGenerating=false on thread ...` 与 `orphaned stuck cron thread ... resetting isGenerating` 两处日志，分别在 cron 任务启动扫描与超时强制复位时触发。也就是说 **is_generating 的 DB 投影被多处"兜底复位"逻辑守护**，不依赖某一个组件写对。

### 4.b 僵尸生成清理：60s 超时 + dbIdle 双判据【实证】

问题场景：内存 `activeGenerations` Map 里登记了一个"生成中"的 handle，但底层其实早就 abort 了（或 DB 里的 `is_generating` 已被复位）。这个 stale 条目会挡住新消息走正常路径。

Alma 在 Steering（生成中插话）检测点做了清理。【实证】bundle 原文还原：

```js
// Steering 拦截判断里的 stale 检查
const aborted = !this.activeGenerations.has(threadId) // handle 已不在
const dbIdle = !this.getThreadById(threadId)?.isGenerating // DB 投影已空闲
const firstSeen = this.generationFirstSeenAt.get(threadId)
const timedOut = dbIdle && Date.now() - firstSeen > 60_000 // 60s 宽限

if (aborted || timedOut) {
  console.warn(
    `[Steering] thread ${threadId} had a stale generation entry ` +
      `(aborted=${aborted}, dbIdle=${dbIdle}) — clearing it and taking the normal path`,
  )
  this.activeGenerations.delete(threadId)
  this.generationTimerResetRefs.delete(threadId)
  this.pendingSteeringMessages.delete(threadId)
  return false // 走正常路径
}
```

**双判据设计很讲究**：

- 只看内存 `aborted` 不够——存在"内存说有、实际死了"的中间态；
- 只看 DB `dbIdle` 也不够——生成刚启动时 DB 写 `is_generating=true` 与内存登记之间存在时序窗口，会误杀。**60s 宽限期**就是给这个窗口的：DB 空闲状态持续超过 60s 才判定 stale。
- 清理要清**三个 Map**：`activeGenerations`（handle）、`generationTimerResetRefs`（超时定时器）、`pendingSteeringMessages`（排队插话）。漏一个就会泄漏或状态错乱。【实证】三行 delete 连续出现。

### 4.c 断线重连 generating_snapshot【实证】

前端（渲染进程）与主进程后端走 WebSocket。WS 断线重连后，前端不知道哪些 thread 正在生成——spinner 状态全丢。Alma 的解法：**连接建立的第一帧就推全量快照**。

【实证】bundle 原文还原：

```js
// WS upgrade 处理：/ws/threads 路径
if ('/ws/threads' === pathname) {
  this.threadSyncClients.add(ws)
  console.log('Thread sync client connected')
  try {
    ws.send(
      JSON.stringify({
        type: 'generating_snapshot',
        data: { ids: Array.from(this.activeGenerations.keys()) },
      }),
    )
  } catch (e) {
    console.error('Failed to send generating_snapshot:', e)
  }
  // ... 之后才挂 on("message") 等正常处理
}
```

配套细节：`generating_snapshot` 在 WS 消息类型白名单里（【实证】bundle 有 `new Set(["generating_snapshot","thread_generating","message_streaming","thread_messages_sync",...])`）。

前端侧恢复逻辑（复刻参考）：

```ts
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.type === 'generating_snapshot') {
    const ids = new Set(msg.data.ids)
    for (const thread of store.threads) {
      thread.isGenerating = ids.has(thread.id) // 全量对齐，不是增量
    }
  }
  if (msg.type === 'thread_generating') {
    store.setGenerating(msg.data.threadId, msg.data.isGenerating)
  }
})
```

### 4.d 工具中断标记【实证】

生成被 abort 时，正在执行的工具 part 不能留在"运行中"状态。Alma 把对应 tool part 置为：

```json
{ "state": "output-error", "errorText": "Tool execution was interrupted" }
```

这样消息落库后是**自洽的**——任何 tool-call 都有确定终态（result 或 error），下次把历史喂给模型时不会出现"悬空调用"。

> **复刻要点**：这条很容易被忽略。如果落库消息里存在 `state: "input-streaming"` 或永不闭合的 tool part，模型下一轮收到会行为异常（有的 provider 直接报 400）。abort 路径必须遍历当前消息的 parts，把所有未闭合 tool part 置为 output-error。

---

## 5. 无状态执行器哲学

Alma spawn 外部 agent（Claude Code）时带的参数：

```
--no-session-persistence --include-partial-messages
```

【实证】。第一个参数**主动放弃**了 Claude Code 自己的 session 持久化机制——每次任务干净起步，不恢复任何历史。

为什么敢这么做？因为 Alma 的架构里：

```
┌──────────────────────────────────────────────┐
│ 进程 = 无状态执行器                            │
│   启动 → 从 DB 读消息历史 → 构造 prompt        │
│        → 跑 → onFinish 写回 DB → 死           │
│   崩溃 → 无所谓，DB 分毫未损                   │
│   重启 → 再读 DB，又是干净的一致状态           │
└──────────────────────────────────────────────┘
        状态只有一个家：SQLite
```

`--include-partial-messages` 则是流式侧的选择：部分消息也要流给 Alma（Alma 自己做流式渲染），但不落 Claude Code 的盘。

**推论**：在这套架构里，"session 持久化"是**反模式**——它引入第二个事实来源，违背 single source of truth。两个事实来源 = 迟早不一致 = 需要 reconcile 逻辑 = 复杂度爆炸。Alma 的选择是物理上杜绝第二个来源。

---

## 6. 下载层 vs 对话层的不对称

一个非常有意思的对比：Alma 在**下载层**做了完整的断点续传，在**对话层**明确不做。

【实证】下载逻辑（bundle 还原）：

```js
// 下载中断 → 指数退避重试，带 resume
console.log(`Download interrupted at ${bytes} bytes; resuming in ${delay}ms`)
const delay = Math.min(1000 * 2 ** attempt, 30000) // 1s,2s,4s... 封顶 30s
// 重试上限 maxRetries 次；resume 通过 HTTP Range 从已下载字节数续传
```

判断标准（【推测】，但从两处设计的对比可以直接读出）：

| 维度               | 文件下载                          | 对话生成                               |
| ------------------ | --------------------------------- | -------------------------------------- |
| **重试成本**       | 高（几百 MB 模型文件重下很贵）    | 低（重跑一轮就是一次 LLM 调用）        |
| **中间状态复杂度** | 极低（就是"已下载 N 字节"一个数） | 高（partial message 的树状 part 状态） |
| **续传正确性**     | 容易保证（字节拼接，可校验）      | 难保证（接续点的上下文语义对齐）       |
| **结论**           | ✅ 做断点续传                     | ❌ 整轮重来                            |

**复刻时的判断标准**：当"重试成本 × 失败概率"远大于"维护续传状态的复杂度成本"时才做断点续传。字节流是最适合续传的（状态是一个整数）；结构化的 LLM 输出是最不适合的（状态是一棵树）。

---

## 7.【复刻施工图】一个文件的完整可运行模块

依赖：`npm i better-sqlite3 ws`（Node 18+）。一个模块覆盖：schema、启动清扫、版本树四操作、activeGenerations 登记处、generating_snapshot 广播、僵尸清理定时器。

```ts
// persistence.ts —— Alma 式持久化与崩溃恢复，可直接搬进项目
// 用法：
//   const store = new PersistenceStore('./chat.db');
//   store.healInterrupted();                        // 进程启动第一件事
//   wss.on('connection', ws => store.onWsConnection(ws));
//   store.startZombieSweeper();                     // 周期性 stale 清理

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'

// ============ Schema ============
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  is_generating INTEGER DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  parent_id TEXT,
  slot_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON chat_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_msg_slot ON chat_messages(slot_id);
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
`

interface ThreadMeta {
  activePath?: string[]
  savedTails?: Record<string, string[]>
  [k: string]: unknown
}
interface GenerationHandle {
  threadId: string
  abort: () => void
  startedAt: number
}

const STALE_TIMEOUT_MS = 60_000 // Alma 实证值：60s

export class PersistenceStore {
  readonly db: Database.Database
  // —— 内存投影（全部可丢弃，DB 才是事实）——
  private activeGenerations = new Map<string, GenerationHandle>()
  private generationFirstSeenAt = new Map<string, number>()
  private pendingSteering = new Map<string, unknown[]>()
  private clients = new Set<WebSocket>()
  private sweeper: NodeJS.Timeout | null = null

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  // ============ A. 启动清扫（进程启动第一件事调用）============
  healInterrupted(): void {
    const now = new Date().toISOString()
    const runs = this.db
      .prepare(
        `UPDATE task_runs SET status='failed', ended_at=?, error='interrupted' WHERE status='running'`,
      )
      .run(now).changes
    const threads = this.db
      .prepare(`UPDATE chat_threads SET is_generating=0 WHERE is_generating=1`)
      .run().changes
    if (runs > 0)
      console.log(`[heal] Marked ${runs} interrupted run(s) as failed`)
    if (threads > 0)
      console.log(`[heal] Reset ${threads} stale is_generating flag(s)`)
  }

  // ============ B. 版本树四操作 ============
  private getMeta(threadId: string): ThreadMeta {
    const row = this.db
      .prepare(`SELECT metadata FROM chat_threads WHERE id=?`)
      .get(threadId) as { metadata: string } | undefined
    if (!row) throw new Error('Thread not found')
    return JSON.parse(row.metadata || '{}')
  }
  private setMeta(threadId: string, meta: ThreadMeta): void {
    this.db
      .prepare(`UPDATE chat_threads SET metadata=? WHERE id=?`)
      .run(JSON.stringify(meta), threadId)
  }

  /** 追加消息；opts.replaceAtMessageId 非空即 regenerate（同 slot 挂新枝） */
  createMessage(
    threadId: string,
    uiMessage: unknown,
    opts: { replaceAtMessageId?: string } = {},
  ): string {
    const now = new Date().toISOString()
    const id = randomUUID()
    return this.db.transaction(() => {
      const meta = this.getMeta(threadId)
      const path = Array.isArray(meta.activePath) ? [...meta.activePath] : []
      let slotId: string | null = null
      let depth = path.length
      let parentId: string | null =
        path.length > 0 ? path[path.length - 1] : null

      if (opts.replaceAtMessageId) {
        // —— regenerate 路径（对应 Alma beginReplaceAtSlot）——
        const idx = path.indexOf(opts.replaceAtMessageId)
        if (idx !== -1) {
          const savedTails = { ...(meta.savedTails ?? {}) }
          savedTails[opts.replaceAtMessageId] = path.slice(idx + 1) // 尾部不丢
          path.length = idx // 截断
          const replaced = this.db
            .prepare(`SELECT slot_id, depth FROM chat_messages WHERE id=?`)
            .get(opts.replaceAtMessageId) as
            | { slot_id: string | null; depth: number }
            | undefined
          slotId = replaced?.slot_id ?? opts.replaceAtMessageId // 继承 slot
          depth = replaced?.depth ?? idx
          parentId = path.length > 0 ? path[path.length - 1] : null
        }
      }

      this.db
        .prepare(
          `INSERT INTO chat_messages
         (id, thread_id, parent_id, slot_id, depth, message, timestamp, metadata, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'{}',?,?)`,
        )
        .run(
          id,
          threadId,
          parentId,
          slotId ?? id /* 新消息默认 slot = 自己 id */,
          depth,
          JSON.stringify(uiMessage),
          now,
          now,
          now,
        )

      path.push(id)
      this.setMeta(threadId, { ...meta, activePath: path })
      this.db
        .prepare(`UPDATE chat_threads SET updated_at=? WHERE id=?`)
        .run(now, threadId)
      return id
    })()
  }

  /** regenerate：先跑生成，成功才落库（失败则旧版本毫发无损） */
  async regenerate(
    threadId: string,
    replaceAtMessageId: string,
    generateFn: () => Promise<unknown>,
  ): Promise<string> {
    const uiMsg = await generateFn()
    return this.createMessage(threadId, uiMsg, { replaceAtMessageId })
  }

  /** 某 slot 的全部版本（前端 ‹ 2/3 › 切换器数据源） */
  listVersions(
    threadId: string,
    slotId: string,
  ): { id: string; created_at: string }[] {
    return this.db
      .prepare(
        `SELECT id, created_at FROM chat_messages
       WHERE thread_id=? AND (slot_id=? OR id=?) ORDER BY created_at ASC`,
      )
      .all(threadId, slotId, slotId) as { id: string; created_at: string }[]
  }

  /** 读当前激活分支，附 versionIndex/versionCount 标注 */
  getActiveBranch(threadId: string): any[] {
    const meta = this.getMeta(threadId)
    const path = Array.isArray(meta.activePath) ? meta.activePath : []
    if (path.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_messages WHERE id IN (${path.map(() => '?').join(',')})`,
      )
      .all(...path) as any[]
    const byId = new Map(rows.map((r) => [r.id, r]))
    const versionCache = new Map<string, { id: string }[]>()
    return path.flatMap((id, i) => {
      const row = byId.get(id)
      if (!row) return []
      const slot = row.slot_id || row.id
      if (!versionCache.has(slot))
        versionCache.set(slot, this.listVersions(threadId, slot))
      const vs = versionCache.get(slot)!
      return [
        {
          ...row,
          message: JSON.parse(row.message),
          metadata: {
            ...JSON.parse(row.metadata || '{}'),
            slotId: slot,
            depth: i,
            versionIndex: vs.findIndex((v) => v.id === row.id),
            versionCount: vs.length,
          },
        },
      ]
    })
  }

  /** 切版本：把 activePath 中某 slot 的活跃消息换成同 slot 的另一版本，恢复其 savedTail */
  selectVersion(threadId: string, slotId: string, messageId: string): void {
    this.db.transaction(() => {
      const meta = this.getMeta(threadId)
      const path = Array.isArray(meta.activePath) ? [...meta.activePath] : []
      // 找到该 slot 当前在 path 中的位置
      const versions = new Set(
        this.listVersions(threadId, slotId).map((v) => v.id),
      )
      const idx = path.findIndex((id) => versions.has(id))
      if (idx === -1) throw new Error('Slot not on active path')
      path[idx] = messageId
      // 若这个版本曾是被替换点，恢复它当时保存的尾部
      const savedTails = { ...(meta.savedTails ?? {}) }
      const tail = savedTails[messageId]
      if (tail) {
        path.length = idx + 1
        path.push(...tail)
        delete savedTails[messageId]
      } else {
        path.length = idx + 1 // 无保存尾部则截断（用户切版本后通常重新生成）
      }
      this.setMeta(threadId, { ...meta, activePath: path, savedTails })
    })()
  }

  // ============ C. 生成状态登记处（内存投影 + DB 投影同步）============
  registerGeneration(handle: GenerationHandle): void {
    this.activeGenerations.set(handle.threadId, handle)
    if (!this.generationFirstSeenAt.has(handle.threadId)) {
      this.generationFirstSeenAt.set(handle.threadId, Date.now())
    }
    this.db
      .prepare(`UPDATE chat_threads SET is_generating=1 WHERE id=?`)
      .run(handle.threadId)
    this.broadcast({
      type: 'thread_generating',
      data: { threadId: handle.threadId, isGenerating: true },
    })
  }

  finishGeneration(threadId: string): void {
    this.activeGenerations.delete(threadId)
    this.generationFirstSeenAt.delete(threadId)
    this.pendingSteering.delete(threadId)
    this.db
      .prepare(`UPDATE chat_threads SET is_generating=0 WHERE id=?`)
      .run(threadId)
    this.broadcast({
      type: 'thread_generating',
      data: { threadId, isGenerating: false },
    })
  }

  /** Steering 检测点：stale 条目清理（Alma 实证的双判据） */
  isGenerationStale(threadId: string): boolean {
    if (!this.activeGenerations.has(threadId)) return false // 本来就没有，不算 stale
    const dbIdle = !(
      this.db
        .prepare(`SELECT is_generating FROM chat_threads WHERE id=?`)
        .get(threadId) as any
    )?.is_generating
    const firstSeen = this.generationFirstSeenAt.get(threadId) ?? 0
    const timedOut = dbIdle && Date.now() - firstSeen > STALE_TIMEOUT_MS
    if (!timedOut) return false
    console.warn(
      `[Steering] thread ${threadId} had a stale generation entry ` +
        `(dbIdle=${dbIdle}) — clearing it and taking the normal path`,
    )
    this.activeGenerations.delete(threadId)
    this.generationFirstSeenAt.delete(threadId)
    this.pendingSteering.delete(threadId)
    return true
  }

  /** 周期清扫器：每 30s 扫一遍，清掉 stale 条目 */
  startZombieSweeper(intervalMs = 30_000): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      for (const threadId of [...this.activeGenerations.keys()]) {
        this.isGenerationStale(threadId)
      }
    }, intervalMs)
    this.sweeper.unref?.()
  }

  // ============ D. WS 断线重连：连接即推快照 ============
  onWsConnection(ws: WebSocket): void {
    this.clients.add(ws)
    try {
      ws.send(
        JSON.stringify({
          type: 'generating_snapshot',
          data: { ids: Array.from(this.activeGenerations.keys()) },
        }),
      )
    } catch (e) {
      console.error('Failed to send generating_snapshot:', e)
    }
    ws.on('close', () => this.clients.delete(ws))
  }

  private broadcast(msg: unknown): void {
    const s = JSON.stringify(msg)
    for (const ws of this.clients) {
      try {
        ws.send(s)
      } catch {
        /* 客户端死了，close 事件会清 */
      }
    }
  }

  // ============ E. 工具中断标记（abort 路径必做）============
  /** 把未闭合的 tool part 全部置为 output-error，保证落库消息自洽 */
  static closeOpenToolParts(uiMessage: any): any {
    if (!uiMessage?.parts) return uiMessage
    for (const part of uiMessage.parts) {
      if (part?.type?.startsWith('tool-') || part?.type === 'dynamic-tool') {
        if (
          part.state !== 'output-available' &&
          part.state !== 'output-error'
        ) {
          part.state = 'output-error'
          part.errorText = 'Tool execution was interrupted'
        }
      }
    }
    return uiMessage
  }
}
```

**接线顺序**（进程启动时）：

```ts
const store = new PersistenceStore('./chat.db')
store.healInterrupted() // 1. 先清扫（DB 投影归零）
store.startZombieSweeper() // 2. 启动周期清扫
wss.on('connection', (ws) => store.onWsConnection(ws)) // 3. WS 接入
// 4. 生成生命周期：
//    store.registerGeneration({ threadId, abort, startedAt: Date.now() });
//    try { const msg = await runLLM(...); store.createMessage(threadId, msg); }
//    catch (e) { /* abort 时记得 PersistenceStore.closeOpenToolParts(msg) */ }
//    finally { store.finishGeneration(threadId); }
```

---

## 8. 复刻 checklist

### ✅ 必须做

| 项                                                                | 为什么                                                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **全量落库**：消息整条 JSON 存，onFinish 一次性 INSERT            | 这是唯一事实来源。流式中途落库只会引入"半个消息"的一致性问题，没有任何收益                                  |
| **启动清扫**：`running→failed/interrupted` + `is_generating` 归零 | 不做的话，崩溃一次就在 UI 上留一个永远"运行中"的幽灵。一行 UPDATE 的事，不做没道理                          |
| **断线快照**：WS 连接首帧推 `generating_snapshot`                 | 不做的话，前端刷新后 spinner 全丢，用户以为生成停了去点重复发送。全量对齐模式（不是增量回放）让前端逻辑极简 |
| **工具中断标记**：abort 时闭合所有 tool part                      | 不做的话，悬空 tool-call 进历史，下一轮直接污染上下文甚至 provider 报 400                                   |

### 🔧 可简化

| 项                | 怎么简化                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **版本树**        | 先只做"同 slot 挂新枝"（regenerate 并存 + `‹ n/m ›` 切换），不做 `savedTails` 尾部恢复——用户切回旧版本后直接重新生成尾部即可。`savedTails` 是体验优化，不是正确性必须 |
| **僵尸清理**      | 可以省略独立定时器，只在 Steering/新消息入口做懒检查（Alma 实证就是挂在检测点做的）。60s 宽限 + dbIdle 双判据不能省                                                   |
| **usage_records** | 早期可以只记 input/output/model 三列，cached/reasoning 等细分后补                                                                                                     |

### 🚫 别做

| 项                                          | 为什么                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Checkpoint 快照**（生成中逐步存状态）     | 对话生成的输入完全确定（消息历史），重跑成本就是一次 LLM 调用。快照引入 schema 迁移、版本兼容、"恢复到一半再崩"的递归问题，换来的是省一次调用。负收益 |
| **崩溃续跑**（从 partial message 接着生成） | partial message 是树状 part 状态，接续点的上下文语义无法对齐，provider 侧也没有"接着上次流"的 API。Alma 连工具中断都只是标记 error 后整轮重来         |
| **执行器 session 持久化**                   | 第二个事实来源 = reconcile 复杂度爆炸。状态只有一个家：你的 DB。外部 agent 一律 `--no-session-persistence`，每次从 DB 读回干净状态                    |

---

> 考古注脚：本篇所有【实证】均可在 Alma v0.0.960 主进程 bundle 与运行期 SQLite 中复核。schema 用 `sqlite3 -readonly ~/Library/Application\ Support/alma/chat_threads.db ".schema <table>"`；行为日志字符串在 `out/main/index.js` 中 grep 对应引号文本即可定位。
