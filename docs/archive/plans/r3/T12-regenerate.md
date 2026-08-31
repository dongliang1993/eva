# T12 · 重新生成 + 版本切换

> 前置：无。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §3。
> 施工图：`docs/architecture/14-eva-architecture.md` §7.2（版本树三件套）、§8（`switch-version` 路由）。

**范围**：只做「重新生成最后一条回复」+「在同一位置的多个版本间切换」。
**明确不做**：编辑历史消息并分叉（真实使用里占比极低，但会把改动面扩大一倍）。

---

## 1. 问题实证

`messages` 表的版本树三件套在 R1 T1 就建好了，但语义从未启用：

```ts
// apps/server/src/services/session.ts:119-129
private append(sessionId, message, runId?) {
  const previous = this.messages.findLastBySessionId(sessionId);
  return this.messages.create({
    sessionId, message,
    slotId: randomUUID(),                              // ← 每条消息各自一个 slot
    depth: previous ? previous.depth + 1 : 0,
    ...(previous ? { parentId: previous.id } : {})      // ← parent 永远是时间上的上一条
  });
}
```

- 每条消息分到全新的随机 `slot_id` → **按构造不可能存在两个版本**；
- `parent_id` 永远指向时间上的上一条 → 树永远退化成一条链。

读路径同样只认时间序：

```ts
// apps/server/src/db/repositories/message-repository.ts:68
.orderBy(asc(messages.createdAt), sql`rowid`)   // 返回全部,不区分分支
```

`grep -rn "switch-version\|regenerate" apps packages` 全仓库零命中。

---

## 2. 目标设计

### 2.1 三个概念

| 列 | 含义 |
|---|---|
| `slot_id` | 对话里的一个**位置**。同一 slot 下的多条消息 = 该位置的 v1 / v2 / v3 |
| `parent_id` | 这条接在谁后面 → 消息构成一棵树 |
| `depth` | 树深度（冗余，便于排序与调试） |

```
user: 帮我写个函数            slot=A depth=0
   └─ assistant: 版本1         slot=B depth=1   ← 同一个 slot
   └─ assistant: 版本2         slot=B depth=1   ← 点「重新生成」产生
        └─ user: 再短一点       slot=C depth=2   ← 只挂在版本2 下面
```

### 2.2 新增一个指针：`sessions.active_leaf_id`

**「当前显示的是哪条分支」需要一个事实源。** 选择"会话级一个叶子指针"而不是"每条消息一个 is_active 标记"：

- 切版本 = 一次写（改指针）；`is_active` 方案要清兄弟、设自己，且每层都得过滤；
- 历史 = 从叶子沿 `parent_id` 上溯，天然只有激活分支；
- 未来做编辑分叉时，这个模型不需要改 —— 分叉只是"新消息的 parent 指向更早的位置"。

`active_leaf_id` 为空（老会话）→ 退化成"取最后一条"，与今天行为完全一致。

### 2.3 两个纯函数（本任务的核心）

```ts
// apps/server/src/services/message-tree.ts

/**
 * 激活链：从叶子沿 parent_id 上溯，返回正序（最早在前）。
 * activeLeafId 为空时退化成"取时间上最后一条"—— 老会话与刚建的会话走这条。
 */
export const buildActiveChain = (
  rows: readonly StoredMessage[],
  activeLeafId: string | null
): readonly StoredMessage[];

/**
 * 从某条消息向下探到叶子：每层取**最新的**子节点。
 *
 * 切版本时用。切到 v2 不能只把指针指向 v2 —— v2 下面可能已经接了后续对话，
 * 用户期望的是"把那条分支整条恢复出来"，所以要下探到分支末端。
 */
export const resolveLeafFrom = (
  rows: readonly StoredMessage[],
  messageId: string
): string;
```

两者都要防脏数据成环（`seen` 集合），否则一条自引用的坏数据能把服务端打挂。

### 2.4 请求契约：`text` 与 `retryMessageId` 二选一

不引入 `mode` 判别字段 —— 现有客户端发的 `{ text, sessionId }` 保持有效：

```ts
runRequestSchema = z.object({
  sessionId: z.string().optional(),
  modelId: z.string().optional(),
  workspaceId: z.string().optional(),
  /** 新消息。与 retryMessageId 二选一。 */
  text: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
  /** 重新生成这条 assistant 消息（同槽位落一个新版本）。二选一，且必须同时给 sessionId。 */
  retryMessageId: z.string().optional()
}).superRefine(/* 恰好一个;retry 必须带 sessionId */)
```

### 2.5 「只能重生成最后一条」怎么表达

服务端硬规则：**`retryMessageId` 必须等于 `sessions.active_leaf_id`，且该消息 role 为 `assistant`。** 否则 400。

这条规则自动覆盖了所有情形：

| 场景 | activeLeaf | 能重生成的 |
|---|---|---|
| 刚回复完 | a1 | a1 ✓ |
| 重生成过一次 | a1v2 | a1v2 ✓（再生成得到 v3） |
| 切回 v1（无后续） | a1v1 | a1v1 ✓ |
| 切到 v2（其下有 user2/a2） | a2 | a2 ✓（v2 本身不行 —— 它不是最后一条） |

### 2.6 落库位置

| 模式 | assistant 消息的 parent / slot / depth |
|---|---|
| send | parent = 新落的 user 消息，slot = 新 UUID，depth = parent.depth + 1 |
| retry | parent / slot / depth **全部沿用被重试的那条** |

两种模式下 assistant 落库后都把 `active_leaf_id` 指向它。

> retry 若被 abort，assistant 消息**仍然落库**（R1 起的规则：任何终态都落库，`metadata.aborted` 标出来），
> activeLeaf 也移到它。用户拿到一条半截的 v2，`‹ 2/2 ›` 可以切回 v1 —— 与 ChatGPT 行为一致。

---

## 3. 涉及文件

### 新增
| 文件 | 内容 |
|---|---|
| `apps/server/src/services/message-tree.ts` | `buildActiveChain` / `resolveLeafFrom` |
| `apps/server/src/db/migrations/0020_active_leaf.sql` | `sessions.active_leaf_id` + 回填 |
| `tests/message-tree.test.ts` | 两个纯函数 |
| `tests/regenerate.test.ts` | API 级：重生成 / 切换 / 历史只含激活分支 |

### 修改
| 文件 | 动作 |
|---|---|
| `apps/server/src/db/schema.ts` | `sessions.activeLeafId` |
| `apps/server/src/db/repositories/types.ts` | `Session.activeLeafId`；`ISessionRepository.updateActiveLeaf`；`CreateMessageInput` 已够用 |
| `apps/server/src/db/repositories/session-repository.ts` | 实现 `updateActiveLeaf` |
| `apps/server/src/services/session.ts` | `append` 按位置落库；`buildModelHistory` 走激活链；新增 `recordRegeneratedAssistant` |
| `apps/server/src/types/runs.ts` | `runRequestSchema` 加 `retryMessageId` + superRefine |
| `apps/server/src/routes/runs.ts` | `openSessionTurn` 分 send / retry 两支 |
| `apps/server/src/routes/threads.ts` | GET messages 返回激活链 + `siblingIds`；新增 `POST /api/v1/messages/:id/switch-version` |
| `apps/server/src/routes/index.ts` | 注册（若 switch-version 另开文件） |
| `packages/shared/src/index.ts` | `ThreadMessage.siblingIds` |
| `apps/web/src/shared/api/run-stream-client.ts` | 请求体支持 `retryMessageId` |
| `apps/web/src/features/threads/api.ts` | `switchVersion` |
| `apps/web/src/features/threads/hooks/use-chat.ts` | `regenerate` / `switchVersion`；run 结束后重拉消息 |
| `apps/web/src/features/threads/components/message-bubble.tsx` | 重生成按钮 + `‹ n/m ›` 切换器 |
| `tests/session.test.ts` | 跟随 append / activeLeaf |

---

## 4. 步骤

> **顺序不可颠倒**：读路径（Step 1–4）必须先于前端（Step 8）。一旦同一 slot 有两条消息而
> `buildModelHistory` 仍返回全部，模型就会同时看到 v1 和 v2 —— 它不报错，只会开始说奇怪的话。

### Step 1 · 迁移 `0020_active_leaf.sql`

```sql
ALTER TABLE `sessions` ADD COLUMN `active_leaf_id` text;
--> statement-breakpoint
-- 回填:老会话的激活叶子 = 时间上最后一条消息。回填后行为与升级前完全一致。
UPDATE `sessions` SET `active_leaf_id` = (
  SELECT `id` FROM `messages`
  WHERE `messages`.`session_id` = `sessions`.`id`
  ORDER BY `created_at` DESC, `rowid` DESC
  LIMIT 1
);
```

journal 追加 `{ "idx": 20, "version": "6", "when": <now-ms>, "tag": "0020_active_leaf", "breakpoints": true }`。

**不加外键**：`active_leaf_id` 指向 messages，而删会话时 messages 走 CASCADE；加 FK 只会给删除顺序添麻烦，而这个指针本身允许悬空（读路径已处理找不到的情况）。

`schema.ts` 的 `sessions` 加 `activeLeafId: text("active_leaf_id")`。

### Step 2 · 【测试先行】两个纯函数

`tests/message-tree.test.ts`（不需要 DB，构造 `StoredMessage[]` 字面量即可）：

- `buildActiveChain`：线性链 → 全量正序；有分支时只返回叶子所在那条；`activeLeafId` 为 null → 退化成最后一条；`activeLeafId` 指向不存在的 id → 返回空（不抛）；自引用脏数据 → 不死循环。
- `resolveLeafFrom`：无子节点 → 返回自己；单链 → 返回末端；某层有两个子节点 → 取**最新**那个；成环 → 不死循环。

然后写 `apps/server/src/services/message-tree.ts`。

### Step 3 · `SessionService` 按位置落库

```ts
/** 一条消息在树里的位置。 */
interface MessagePosition {
  readonly parentId: string | null;
  readonly slotId: string;
  readonly depth: number;
}
```

- `private positionAfterActiveLeaf(sessionId): MessagePosition`
  —— parent = `session.activeLeafId` 指向的消息（拿不到就退化成"最后一条"），slot = 新 UUID，depth = parent ? parent.depth + 1 : 0。
  **注意：不能再用 `findLastBySessionId`** —— 切回旧版本后，"时间上最后一条"属于另一条分支，接上去会把新消息挂错位置。
- `private positionAlongside(target: StoredMessage): MessagePosition`
  —— 原样沿用 target 的 parent / slot / depth。
- `append(sessionId, message, position, runId?)` 落库后**总是**写 `updateActiveLeaf(sessionId, stored.id)`。
- 新增 `recordRegeneratedAssistant(sessionId, message, target, runId?)`。

### Step 4 · `buildModelHistory` 走激活链

```ts
/**
 * 模型可见历史。
 * @param leafId 从哪条消息回溯;缺省用 session.activeLeafId。
 *   retry 模式传"被重试消息的父",这样历史里不含被重试的那条回复本身。
 */
buildModelHistory(db: AppDatabase, sessionId: string, leafId?: string): ModelHistory
```

内部：`findBySessionId`（全量，limit 2000）→ `buildActiveChain(rows, leafId ?? session.activeLeafId)` → 再按 compaction 截尾（现有逻辑不变）。

> **compaction 的已知边界**：`session_compactions.covered_until_message_id` 可能落在非激活分支上，
> 此时现有的 `coveredIdx >= 0 ? … : slice(-preservedTailMessageCount)` 回退分支会生效 ——
> 结果是"摘要 + 尾部 N 条"，语义仍然正确，只是覆盖范围可能偏保守。**本任务不处理**，
> 在 FINDINGS 记一条 `[r4]`（正确解法是 compaction 记录也挂到分支上）。

### Step 5 · run 路由分两支

`openSessionTurn` 拆成两条清晰路径，返回同一个 `OpenTurn`：

```ts
interface OpenTurn {
  readonly sessionId: string;
  /**
   * runs 台账的 user_message_id，同时也是模型可见历史的末端。
   * send 模式 = 刚落库的用户消息;retry 模式 = 被重试消息的父（就是那条用户消息）。
   */
  readonly userMessageId: string;
  /** 本轮 assistant 消息在树里的落点。 */
  readonly assistantPosition: MessagePosition;
  readonly workspace?: ResolvedWorkspaceContext | undefined;
  readonly createdSessionId?: string | undefined;
}
```

retry 支的校验（任一不满足 → 400，错误文案面向用户）：

1. `sessionId` 对应的会话存在；
2. `retryMessageId` 存在且 `sessionId` 匹配（防跨会话重试）；
3. `message.role === "assistant"`；
4. `message.id === session.activeLeafId`（只能重生成最后一条，见 §2.5）。

retry 支**不落任何新消息**，直接算出 `assistantPosition = positionAlongside(target)`。

后续（模型解析 / MCP / 工具 / 流式 / 落库）两支共用 —— 落 assistant 时用 `assistantPosition`。

### Step 6 · GET messages 返回激活链 + 版本信息

`packages/shared` 的 `ThreadMessage` 加：

```ts
/**
 * 同槽位的全部版本 id，按创建顺序。长度 > 1 时前端显示 ‹ n/m › 切换器。
 * 不额外给 index/count —— 前端用 siblingIds.indexOf(id) 就能算，避免三份冗余数据不一致。
 */
siblingIds: readonly string[];
```

`routes/threads.ts` 的 GET messages：全量 rows → 按 `slot_id` 分组算 siblings → `buildActiveChain` 取激活链 → 映射输出。

### Step 7 · `POST /api/v1/messages/:id/switch-version`

（路由名沿用 `docs 14 §8` 的规划；`:id` = 要切到的那条消息。）

```
→ 404 消息不存在
→ 200 { messages: ThreadMessage[] }   切换后的激活链,前端直接替换,不用二次请求
```

实现：`activeLeafId = resolveLeafFrom(rows, id)` → `updateActiveLeaf` → 返回新激活链。

> 允许切到任意消息（不限同槽位）—— 规则简单且天然支持未来的分叉。前端只在同槽位之间提供按钮。

### Step 8 · 前端

1. `run-stream-client.ts`：请求体加 `retryMessageId`（与 `text` 二选一）。
2. `use-chat.ts`：
   - `regenerate(messageId)` —— 把 committed 里那条移除、开一个 streaming 气泡、发 `{ sessionId, retryMessageId }`；
   - **run 结束后重新拉 `GET /threads/:id/messages`** —— `siblingIds` 只有服务端算得准，不要在前端拼；
   - `switchVersion(messageId)` —— POST 后用返回的 messages 直接替换 committed。
3. `message-bubble.tsx`：
   - 「重新生成」按钮：仅 assistant、仅激活链最后一条、非流式中；
   - `‹ n/m ›` 切换器：`siblingIds.length > 1` 时显示，左右调 `switchVersion(siblingIds[idx ± 1])`。

### Step 9 · 【测试先行】API 级验收

`tests/regenerate.test.ts`（照 `tests/run-lifecycle.test.ts` 的假 agent + 真 DB 搭建）：

- send → regenerate → 该 slot 下有 2 条消息、`active_leaf_id` = v2；
- **`buildModelHistory` 只含激活分支**（v1 不在里面）—— 这条是本任务最重要的断言；
- retry 时历史末端是那条 user 消息（不含被重试的 v1）；
- switch 回 v1 → 激活链到 v1 为止；再 switch 到 v2 → 若 v2 下有后续，整条恢复（`resolveLeafFrom` 下探）；
- 切到 v1 后发新消息 → 新消息 parent = v1（**不是**时间上最后一条）；
- 非法 retry：跨会话 / 非 assistant / 不是 activeLeaf → 400。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；`message-tree` / `regenerate` 两份测试 RED→GREEN
- [ ] 手工：发一条消息 → 对回复点「重新生成」→ 出现新回复，气泡下有 `‹ 2/2 ›`
- [ ] 手工：点 `‹` 回到 v1，点 `›` 回到 v2，内容正确来回切
- [ ] 手工：切到 v1 后继续发消息 → 新消息接在 v1 后面；切到 v2 → v2 那条分支（含它后面的对话）整条恢复
- [ ] 手工：连续重生成三次 → `‹ 3/3 ›`，三个版本都能切到
- [ ] 手工：重生成中途点停止 → 半截的 v2 落库并激活，可切回 v1
- [ ] **上下文正确性**：切到 v1 后追问"你刚才说了什么"，模型只提 v1 的内容（证明历史只含激活分支）
- [ ] `sqlite3 ~/.eva/eva.db "select slot_id, count(*) from messages group by slot_id having count(*) > 1"` 能看到多版本槽位
- [ ] 老会话（升级前建的）打开正常、能继续对话（回填 + 退化路径生效）

## 6. 坑

1. **读路径先改**（见 §4 开头）。这是本任务唯一的静默失败模式。
2. **`findLastBySessionId` 不能再当 parent 用**。切回旧版本后它属于另一条分支。全仓库 `grep findLastBySessionId` 确认只剩合理用途（或删掉）。
3. **`resolveLeafFrom` 每层取"最新"子节点**依赖 rows 的顺序（`createdAt, rowid` 升序）。别改 `findBySessionId` 的 orderBy，或者在函数内显式排序。
4. **成环防护不是防御性编程**：`active_leaf_id` 允许悬空、脏数据可能自引用，两个纯函数都必须有 `seen` 集合，否则一条坏数据能把服务端打挂。
5. **`ThreadMessage` 是前后端共享契约**，加字段前端会编译不过 —— 先改 `packages/shared`，用 `pnpm typecheck`（T13 之后才覆盖前端；在那之前手工 `pnpm --filter @eva/web exec tsc -p tsconfig.json --noEmit`）列出所有断点。
6. **别顺手做编辑分叉**。它需要"截断后续 or 分叉"的 UX 决策、消息编辑框、以及 user 消息也要有 siblingIds。本轮范围外，想做另开一个任务。
