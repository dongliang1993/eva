# T16 · 记忆的人类可读层（L1 / L2）

> 前置：无（与 T15 无共同文件，可并行）。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §3。
> 施工图：`docs/architecture/05-memory-subsystems.md` §9（含四个工具的完整设计与三个坑）、`14-eva-architecture.md` §11。

---

## 1. 问题实证

`docs/architecture/00-overview.md` 把「本地优先 + **文件即数据库的可读记忆**」列为三个关键设计哲学的第一条：

> 结构化数据进 SQLite；但"记忆、人格、技能"全部是 **人类可读的 Markdown 文件**。
> 这让 agent 和用户都能直接读写记忆，调试成本极低。

四层记忆（`docs 14 §11`）里，机器层齐了、人类层一片空白：

| 层 | 载体 | 现状 | 实证 |
|---|---|---|---|
| **L1 长时记忆** | `MEMORY.md` 全文注入 | ❌ | `grep -rn "MEMORY.md" apps packages` 零命中 |
| **L2 每日笔记** | `memory/YYYY-MM-DD.md` | ❌ | 同上 |
| L3 会话归档 | `messages_fts` | ✅ | 0005 迁移 + `message-search-repository.ts` |
| L4 语义索引 | `memory_embeddings`（vec0） | ✅ | 0008 迁移 + `memory-embedding.ts` |

现有记忆工具只有两个，都只写 DB：`save_memory`（`memories` 表）+ `search_memory`（vec + FTS 混合召回）。

**具体后果**：记忆全在 SQLite 里，用户**没法打开编辑器读一眼、改一行**。想知道"Eva 记住了我什么"
只能去点 Settings 的 Memory 页；想纠正一条错记忆得在 UI 里翻。

而 `apps/server/SOUL.md`（你写的 Eva 人格文件，3.2 KB）已经证明这个机制能跑 ——
`prompts/soul.ts` 就是"读文件 → `PromptSection` → 注入 system prompt"的现成范式。缺的只是同一个套路再走一遍。

---

## 2. 目标设计

### 2.1 文件布局（`docs 14 §7.3`）

```
~/.eva/                          ← evaDataDir()，R2 T6 起就是唯一用户数据根
├── eva.db
├── mcp.json
├── skills/<name>/SKILL.md
├── MEMORY.md                    ★ L1：长期事实与偏好，每轮全文注入
├── memory/
│   ├── 2026-08-19.md            ★ L2：当天日记
│   └── 2026-08-18.md
└── tool-overflow/<workspaceId>/
```

`SOUL.md` **保持现状**（在 `apps/server/SOUL.md`，随包分发、启动时加载一次）——
它是产品自带的人格，不是用户数据。**不要顺手把它也搬到 `~/.eva/`**：那会让打包好的
人格变成"用户目录里可能不存在的文件"，Eva 装完第一次启动就没人格了。

### 2.2 注入时机：per-run 读，不是启动时读

`SOUL.md` 在 `deps.ts` 启动时读一次就够（它不会在会话中变）。
**`MEMORY.md` 会在会话中被 agent 改写**，所以必须每轮读。

跟随 R2 T6 建立的 `project-docs.ts` 范式（per-run 读 + 字节上限 + 截断标记），一模一样的套路：

```ts
/**
 * 注入上限。MEMORY.md 每轮全量进 system prompt,而它是人+agent 共同写的、
 * 没有任何机制阻止它长到几百 KB —— 失控的是持续成本,不是一次性成本。
 * 8 KB ≈ 2k token:够放几十条稳定事实,超了就该让 agent 精简而不是继续堆。
 */
const MAX_LONG_TERM_BYTES = 8 * 1024;

/** 注入最近几天的日记。1 天太短(昨天的决定就忘了),3 天以上开始挤占预算。 */
const DAILY_NOTE_DAYS = 2;
```

产出一个 `PromptSection`：

```
## Memory Files

### MEMORY.md
（全文，或截断 + 标记）

### memory/2026-08-19.md
（今天的日记）

### memory/2026-08-18.md
（昨天的）
```

两个文件都不存在 → 返回 `undefined`（**不要注入空标题，那是给模型的噪音** —— `project-docs.ts` 的既有判断）。

### 2.3 三个新工具

按 `docs 05 §9.9` 的设计，去掉它的 `searchMemory`（Eva 已经有 DB 版的 `search_memory`）：

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `read_memory_file` | 读某个记忆文件的全文；**不传 `file` 时列出有哪些文件** | 防路径穿越（`docs 05` 坑①） |
| `append_memory` | 往今天的日记追加一条 | 进程内写锁串行化 |
| `update_long_term_memory` | **整文件替换** `MEMORY.md` | description 必须大写强调 REPLACES（`docs 05` 坑②） |

`read_memory_file` 不传 `file` 就列目录，是为了解决一个真实缺口：**只注入最近 2 天，更早的日记
模型无从得知存在**。让它能先列出日期再决定读哪天，比加第四个工具便宜。

三个工具都返回 `saved: true + 文件路径` 式的回显（`docs 05` 坑③：模型会在回复里自然引用，用户可见）。

### 2.4 与 DB 记忆的分工（**这是本任务最重要的设计决定**）

做完之后 Eva 会有 **5 个记忆工具**。如果不把边界说清楚，模型一定会把同一条事实同时存进两处 ——
那就是这个仓库前三轮一直在消灭的"同一事实多个来源"。

分工按**规模与访问模式**切（不是按内容切），与 `docs 14 §11` 的 L1 vs L4 同一个逻辑：

| | `MEMORY.md`（L1） | `memories` 表（L4） |
|---|---|---|
| 量级 | 几十条，**每轮全量注入** | 成百上千条，**按需检索** |
| 内容 | 稳定的身份/偏好/长期约束 | 项目事实、决定、知识点、一次性细节 |
| 谁维护 | agent 用 `update_long_term_memory` 整文件重写；**用户也直接编辑** | agent 用 `save_memory`；用户在 Settings 里管 |
| 判据 | "这条事实值得每轮都花 token 带着吗？" | 其余全部 |

**落地方式不是写注释，是改 prompt**：`agent.ts` 已有的 `MEMORY_PROMPT_SECTION` 是唯一
告诉模型"什么时候用哪个"的地方，本任务把路由规则写进它。一处说清，别在 5 个工具的
description 里各写一遍（会互相矛盾）。

### 2.5 不做

- **记忆文件进 FTS / 向量索引**（`docs 05 §9` 的 `reindex`）。`MEMORY.md` 每轮全量注入、不需要检索；
  日记的检索有价值但要再铺一条索引管线。记 FINDINGS `[r5]`。
- **`USER.md` 用户画像**（`docs 05 §203` 的三文件人格层第二个）。`MEMORY.md` 里开一个
  `## 关于用户` 小节就够，多一个文件多一处要同步。真需要时再拆。
- **会话结束写日记 hook**（`docs 05 §9.10`）。先让 agent 自己判断该不该记 ——
  自动写日记会产生大量"今天用户问了 X"的噪音条目。等观察到 agent 不主动记再加。

---

## 3. 涉及文件

### 新增
| 文件 | 内容 |
|---|---|
| `packages/harness/src/tools/memory/memory-files.ts` | `MemoryFileStore` 接口（harness 定契约，server 给实现，与既有 `MemoryStore` 同一套路） |
| `packages/harness/src/tools/memory/read-memory-file-tool.ts` | `read_memory_file` |
| `packages/harness/src/tools/memory/append-memory-tool.ts` | `append_memory` |
| `packages/harness/src/tools/memory/update-long-term-memory-tool.ts` | `update_long_term_memory` |
| `apps/server/src/services/memory/memory-file-store.ts` | 文件读写 + 路径守卫 + 写锁 |
| `apps/server/src/services/memory/memory-files-section.ts` | per-run 读 → `PromptSection` |
| `apps/server/src/services/memory/index.ts` | re-export |
| `tests/memory-file-store.test.ts` | 路径穿越 / 写锁 / 日记按天 / 截断 |
| `tests/memory-files-section.test.ts` | 注入内容与"都不存在返回 undefined" |

### 修改
| 文件 | 动作 |
|---|---|
| `apps/server/src/paths.ts` | `longTermMemoryPath()` / `dailyNoteDir()` / `dailyNotePath(date)` |
| `packages/harness/src/tools/memory/index.ts` | 导出三个新工具 |
| `apps/server/src/agent.ts` | `MEMORY_PROMPT_SECTION` 写进路由规则（§2.4）；注入 memory-files section |
| `apps/server/src/routes/runs.ts` | per-run 读 memory files（与 `loadProjectDocsSection` 并列） |
| `apps/server/src/services/memory-runtime.ts` | 把三个新工具并进 `additionalTools` |
| `.gitignore` | 无需改（`~/.eva/` 不在仓库里） |
| `AGENTS.md` | Configuration 一节补 `~/.eva/MEMORY.md` 与 `memory/` |

**不新增迁移**（本任务不碰 DB）。

---

## 4. 步骤

### Step 1 · `paths.ts` 加三个路径

```ts
/** L1 长时记忆。用户可以直接用编辑器打开改 —— 这是"文件即数据库"的全部意义。 */
export const longTermMemoryPath = (): string => path.join(evaDataDir(), "MEMORY.md");

export const dailyNoteDir = (): string => path.join(evaDataDir(), "memory");

/** @param date YYYY-MM-DD（调用方给,不在这里取 now —— 便于测试注入日期）。 */
export const dailyNotePath = (date: string): string =>
  path.join(dailyNoteDir(), `${date}.md`);
```

> `dailyNotePath` 不自己取当前日期：取 now 的函数没法测。日期由调用方传，
> 服务端在一个地方算 `todayString()`。

### Step 2 · 【测试先行】`memory-file-store.ts`

`tests/memory-file-store.test.ts`（用 `mkdtempSync` 造临时根，store 接受注入的根目录）：

- `readFile("MEMORY.md")` 不存在 → 返回 undefined（不抛）；
- `readFile("../../etc/passwd")` / 绝对路径 / `memory/../../x` → **拒绝**（`docs 05` 坑①）；
- `list()` 返回 `MEMORY.md` + `memory/*.md`，按日期倒序；
- `appendDailyNote(date, note)` → 文件不存在则建（带 `# YYYY-MM-DD` 标题），存在则追加；
- `writeLongTermMemory(content)` → 整文件替换；
- **并发写不交错**：同时发 10 个 `appendDailyNote`，10 条都在、无截断（进程内写锁）。

实现要点：

```ts
/**
 * 记忆文件的读写。
 *
 * 路径守卫:工具入参不可信,resolve 后必须确认仍在记忆根之内 —— 与 fs 工具的
 * resolveWorkspacePath 同一个红线,只是根不同。
 * 写锁:agent 可能在一轮里并发调多次写工具(并行 tool call),不串行化会互相截断。
 */
export class MemoryFileStore {
  constructor(private readonly root: string) {}
  // resolveInsideRoot / readFile / list / appendDailyNote / writeLongTermMemory
}
```

写锁用 `docs 05 §9.9` 的 promise 链（`writeQueue = writeQueue.then(fn, fn)`），
**不要引锁库** —— 一个进程内的串行化不值得一个依赖。

### Step 3 · 【测试先行】注入 section

`memory-files-section.ts`：读 `MEMORY.md` + 最近 `DAILY_NOTE_DAYS` 天日记 → `PromptSection`。
照 `project-docs.ts` 的形状（同一个 header + 截断标记套路）。

`tests/memory-files-section.test.ts`：都不存在 → `undefined`；只有 MEMORY.md → 只含它；
超 8 KB → 截断且带标记；日记按日期倒序（今天在前）。

### Step 4 · 三个工具

`MemoryFileStore` 的**契约**放 harness（`memory-files.ts`），实现留 server ——
与既有 `MemoryStore` 完全同一套路（harness 定接口、server 注入实现）。

`update_long_term_memory` 的 description **必须**包含（`docs 05` 坑②原文）：

> "Read it first with `read_memory_file("MEMORY.md")`, then write back the full updated content —
> this tool **REPLACES the whole file**. Keep it short and factual; ephemeral events belong in `append_memory`."

不写这句，模型会只传增量片段把旧记忆整个冲掉。

### Step 5 · 路由规则写进 `MEMORY_PROMPT_SECTION`

`agent.ts` 现有的那段（6 行，只讲 DB 版工具）改成同时讲清 5 个工具的分工。判据要给模型
一句能直接照着判的话，比如：

> Ask yourself: *is this fact worth spending tokens on every single turn?*
> Yes → `update_long_term_memory`. No → `save_memory`.

### Step 6 · 接线

`routes/runs.ts` 在 `loadProjectDocsSection` 旁边并列读 memory files section；
`memory-runtime.ts` 把三个新工具并进 `additionalTools`（它已经在这么做 `save_memory` / `search_memory`）。

**注意**：memory files 与工作区无关（`~/.eva` 是全局的），所以**没绑工作区的会话也要注入** ——
不要写进 workspace 分支里。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；两份新测试 RED→GREEN
- [ ] 手工：`echo "## 饮食偏好\n- 喜欢吃汉堡🍔" > ~/.eva/MEMORY.md` → 新会话问"我喜欢吃什么" → agent 答得出（证明全文注入）
- [ ] 手工：对话里说"记住：我用 pnpm 不用 npm" → agent 调 `update_long_term_memory` → **`cat ~/.eva/MEMORY.md` 能看到这条**
- [ ] 手工：**第二天**（或改系统日期）开新会话 → 仍然记得（这是 L1 与"会话内记忆"的分界线）
- [ ] 手工：手动编辑 `~/.eva/MEMORY.md` 删掉一条 → 新会话里 agent 不再提它（用户可直接改，不用过 UI）
- [ ] 手工：说"今天决定先做子代理再做记忆" → agent 调 `append_memory` → `~/.eva/memory/YYYY-MM-DD.md` 出现该条
- [ ] 手工：`read_memory_file` 不传参 → 列出 `MEMORY.md` 与日记文件名
- [ ] 安全：让 agent `read_memory_file("../../../etc/passwd")` → 被拒且错误可读
- [ ] 分工不串：说一条项目细节（如"这个仓库的迁移是手写 SQL"）→ agent 用 `save_memory` 而不是塞进 `MEMORY.md`
- [ ] `MEMORY.md` 写到 > 8 KB → system prompt 里被截断且有标记（不是静默丢尾部）

## 6. 坑

1. **`update_long_term_memory` 不强调 REPLACES → 记忆被冲掉**（`docs 05` 坑②）。这是本任务最容易翻车的一处，
   description 里必须大写，且验收里要专门试一次"改一条不丢其它条"。
2. **路径穿越**（坑①）。`read_memory_file` 的 `file` 是模型给的，`resolve` 后必须确认前缀。
   与 fs 工具的 `resolveWorkspacePath` 是同一条红线、不同的根 —— 复用它的写法但**不要复用它的根**。
3. **并发写截断**（坑③的隐含前提）。模型可能在一轮里并行调两次 `append_memory`。
   进程内 promise 链串行化，别引锁库。
4. **5 个记忆工具是真实的选择困难**。做完后观察 agent 是否把该进 DB 的塞进了 `MEMORY.md`
   （或反之）。若确实混乱，下一步不是加第 6 个工具，而是**收窄**：让 `save_memory` 只做
   "项目/知识"类，`MEMORY.md` 只做"用户/偏好"类，在工具 schema 的 category 上强制。
5. **不要把 `SOUL.md` 搬到 `~/.eva/`**（§2.1）。它是随包分发的产品人格，搬走等于新装的 Eva 没有人格。
6. **per-run 读，不是启动读**。`MEMORY.md` 会被 agent 在会话中改写；照 `SOUL.md` 那样只在
   `deps.ts` 读一次，agent 写完之后当轮甚至下一轮都看不到自己写的东西。
