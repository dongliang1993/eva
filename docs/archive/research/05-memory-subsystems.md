# 05 · Alma 记忆系统与周边子系统

> 本文档基于对本机 Alma 安装（`/Applications/Alma.app`）、用户数据目录（`~/.config/alma`、`~/.alma`、`~/Library/Application Support/alma`）以及 `chat_threads.db` SQLite 数据库 Schema 的实证调研写成。
> 标注「推测」的条目表示从字符串/表结构/目录布局推断、未逐行核对源码。

> **v0.0.990 修订（2026-08-21）**：本篇的四层分层框架（L1 文件 / L2 日记 / L3 归档 / L4 向量）在 v0.0.990 仍然成立，但两处核心论断已被推翻、若干新机制未覆盖，详见 **18/20 篇**：
>
> - **Embedding 默认路径翻转（本篇 §2 与「反模式提醒」已过期）**：v0.0.990 默认是**云端 OpenAI 兼容 `text-embedding-3-small`**，vec0 表定义为 `embedding FLOAT[1536]`（`main.readable.js:1793`）；本地 transformers.js（4 个 384 维 Xenova 模型）降级为 `providerId=__local__` 可选项，由 `/api/local-embeddings/models|download|progress` 管理（`:77658-77670`）。`getEmbeddingProvider()` 优先级链：settings 指定 → openai → aihubmix → openrouter → google → custom。**维度切换**：`ensureVectorTableDimensions` 只在 vec0 表为空时 DROP 重建（`:1848`）；非空时换模型触发 `rebuildEmbeddings` 全量重建（试算首条定维度 → 每 10 条一批重算 → `memory_metadata.embedding_model` 记账，`:1884-1984`），路由 `/api/memories/rebuild|rebuild-progress|cancel-rebuild`（`:77615` 等）。
> - **「混合检索 RRF」不成立**：v0.0.990 全 bundle grep 不到 `rrf|bm25|hybrid`；记忆检索是**纯 vec0 余弦 KNN**（SQL 原文 `:2186-2190`：`SELECT memory_id, 1 - vec_distance_cosine(embedding, ?) as score FROM memory_embeddings WHERE score >= ? ORDER BY score DESC LIMIT ?`）+ userIds/threadId/tags 后置过滤；FTS5（`messages_fts`）只服务历史消息搜索，与记忆检索不融合。中文检索靠 tool model 查询改写（统一转英文检索词）补齐。
> - **memory 表族新增**：`memories` 经 ALTER 增 **`user_id`** 列（`:1836`，多通道 `platform:external_user_id` 命名空间隔离）；`memory_archive` 初始即含 `user_id`（`:1799`）；**`memory_sleep_runs`** 表坐实 sleep 流程审计（`:1802` SQL 原文，列含 `trigger: manual|idle|count|scheduled`、`archived_exact/expired/orphan/similarity/llm` 五路计数、`input_tokens/output_tokens`）——sleep 是**四层归档管线**（exact 去重 → temporary 过期 → 相似度聚类（阈值 0.95 直接合并）→ LLM 合并（≥0.75 进 LLM、批 20 条、簇上限 50）），每日 03:00 触发、3 连败退避、`/api/memories/sleep/run|preview|cancel` 手动入口，详见 20 篇。
> - **写入时机提前**：从「会话结束归档」提前为**每轮 assistant 响应完成后后台自动提取**（最近 4 条消息、`metadata.memoryExtracted` 去重、ADD 走 `addMemoryWithLLMDedup` LLM 判重，`:91811`、`:87447`）；另有 DELETE 操作与 temporary 记忆即时清理回路。
> - **Activity Recorder 坐实**：本篇 §4 的目录级推测在 v0.0.990 已全部落地——`activity_sessions/events/snapshots/ocr_frames/summaries` 五张表（SQL 原文 `:2838-2853`），macOS 走 ScreenCaptureKit daemon + 运行时编译的 Swift helper（Vision OCR + NSEvent 全局输入监听），OCR 文本正则脱敏后入库，分析产出 `memoryCandidates` 反哺主记忆库；18 条 `/api/activity-recorder/*` 路由。详见 20 篇。

---

## 1. Memory 分层架构

Alma 的记忆不是单一存储，而是**四层结构**，写入与检索路径各不相同：

| 层 | 载体 | 写入路径 | 检索路径 |
|---|---|---|---|
| **L1 长时记忆** | `~/.config/alma/MEMORY.md` | 会话中由 `memory_*` 工具（save/update/delete）写入；同时落库 `memories` 表 | 每次会话开始**全文注入** system prompt；同时参与向量索引 |
| **L2 每日笔记** | `~/.config/alma/memory/YYYY-MM-DD.md` | 会话中追加当天发生的事实、决定、待办 | 按日期读取；近期日志参与语义检索 |
| **L3 会话归档** | `chat_threads.db`（messages + `messages_fts`）+ `memory_archive` 表 | 会话结束/休眠时自动总结、归档 | FTS5 全文检索 + 向量检索 |
| **L4 语义索引** | `memory_embeddings`（vec0 虚拟表） | 记忆写入时同步计算 embedding | sqlite-vec KNN 近邻搜索 |

实证要点：

- `MEMORY.md` 是纯 Markdown（本机实例只有「## 饮食偏好 / 喜欢吃汉堡🍔」），配 `USER.md`（用户画像）一起构成人格层。
- `memory/2026-04-04.md` 这类每日笔记按天滚动，类似日志缓冲区。
- SQLite `chat_threads.db` 中实测存在：
  - `memories(id, content, metadata, thread_id, message_id, created_at, updated_at, user_id)` — 记忆主表，软关联线程；
  - `memory_archive(id, original_id, content, metadata, thread_id, message_id, user_id, original_created_at, original_updated_at, archived_at, archived_reason, archived_by, merged_into)` — 归档表，记录归档原因（exact / expired / orphan / similarity / llm）与合并去向；
  - `memory_sleep_runs(...)` — 「睡眠整理」批处理运行记录，字段含 `examined / archived_exact / archived_expired / archived_orphan / archived_similarity / archived_llm / input_tokens`，说明归档是一个**带 LLM 判定的离线整理流程**（推测：类似"睡眠时大脑整理记忆"的 cron 任务）。
  - `messages_fts` — 对全部历史消息建的 FTS5 全文索引。

```
用户消息 ──┬──> L1 MEMORY.md（持久事实、偏好）        ──> 全文注入 prompt
           ├──> L2 memory/今日.md（流水日志）           ──> 近期注入/语义检索
           ├──> L3 消息库 + memory_archive（历史）      ──> FTS5 + 向量检索
           └──> L4 memory_embeddings（384 维向量）      ──> sqlite-vec KNN
                                    │
              离线「睡眠整理」cron <──┘（去重/过期/合并/LLM 判定 → memory_archive）
```

---

## 2. 语义检索实现

**Embedding 模型**：本地运行，不依赖云端 API。

- 引擎：transformers.js（Xenova 发行版），模型缓存于 `~/Library/Application Support/alma/embedding-models/Xenova/`。
- 实测模型目录：`all-MiniLM-L6-v2` 与 `multilingual-e5-small`。
- `memory_embeddings` 虚拟表定义为 `embedding FLOAT[384]` —— 与两个模型的输出维度（384）一致。
- 中文场景应使用 `multilingual-e5-small`（多语言），英文/默认用 `all-MiniLM-L6-v2`（推测：按记忆内容语言或全局设置选择，或做双索引）。

**向量存储**：sqlite-vec 扩展。

```sql
CREATE VIRTUAL TABLE memory_embeddings USING vec0(
    memory_id TEXT PRIMARY KEY,
    embedding FLOAT[384]
);
```

辅助表 `memory_embeddings_chunks / _rowids / _vector_chunks00` 是 sqlite-vec 的内部存储布局。元信息表显示 `CREATE_VERSION = v0.1.7-alpha.2`（sqlite-vec 版本）。

**全文检索**：FTS5 虚拟表 `messages_fts(message_id UNINDEXED, thread_id UNINDEXED, content)`，覆盖所有会话消息。

**混合检索**（推测 + 字符串证据）：`app.asar` 中存在 `memory_hybrid` / `memory_hybrid_context` 标识（出现 30+ 次），说明检索工具是**向量 KNN + FTS5 关键词的混合排序**，合并后按相关度取 Top-N 注入 prompt。检索时以当前用户消息为 query 做 embedding，在 vec0 中查近邻，同时跑 FTS5 匹配，再融合去重。

---

## 3. 自动归档与注入机制

### 3.1 记忆如何进入 system prompt

从 `app.asar` 提取到的 prompt 模板片段（实证）：

```
Relevant Memories
The following are relevant memories from previous conversations:
```

以及一句机制说明（实证）：

```
"Relevant Memories" you were handed are only a small semantic slice ...
```

即：每次会话组装 system prompt 时，按当前消息做语义检索，把 Top-N 条记忆以 `Relevant Memories` 段落注入。`MEMORY.md` 全文（人格/偏好层）推测为常驻注入；每日笔记与归档记忆则走检索注入。

### 3.2 记忆写入工具

`app.asar` 中存在一组记忆管理工具的 Schema 标识（实证）：`memory_list`、`memory_status`、`memory_recurrent`、`memory_recurrent_context`、`memory_20250818`（带日期戳的工具版本号，说明工具 Schema 经历过版本迁移）。推测完整集合为 save / update / delete / list / status / search（hybrid）。

### 3.3 离线整理（"睡眠"归档）

`memory_sleep_runs` 表（实证）记录每次整理运行：触发方式（`trigger`）、检查条数、按五类原因归档（精确重复 exact / 过期 expired / 孤儿 orphan / 相似合并 similarity / LLM 判定 llm）、消耗的 token 数。归档记录进 `memory_archive`，支持 `merged_into` 指向合并后的记忆 —— 即**相似记忆会被合并而不是简单删除**。

### 3.4 people / groups 画像

- `~/.config/alma/groups/` 目录存在（本机含 `state.json`），配合多人群聊场景记录群组状态与成员画像（推测：按 group_id 存成员摘要、群规、活跃话题）。
- `USER.md` 是对话主人的画像文件，随 `MEMORY.md` 一起注入。
- 推测 people 画像生成：会话中识别到新联系人时积累事实，定期由 LLM 汇总成画像 Markdown，参与语义检索。

---

## 4. Activity Recorder（活动记录器）

数据目录（实证）：`~/.alma/activity-records/snapshots/YYYY-MM-DD/`，文件命名 `2026-08-13T02-59-58-634Z-<hash>.jpg`；另有 `~/.alma/cache/activity-recorder/` 与 `cache/focused-window-probe/`。

工作机制（基于目录与缓存布局的实证 + 推测）：

1. **定时截屏**：按固定间隔（实测同一分钟内约 20-30 秒一张）抓取屏幕 JPEG 快照。
2. **前台窗口探测**：`focused-window-probe` 缓存说明每张快照伴随当前聚焦应用/窗口标题的采集。
3. **OCR 与会话切分**：截图文本经 OCR 提取后，按「活动会话」切分（应用切换/空闲超时作为边界），生成可检索的活动摘要。
4. **语义搜索**：活动记录进入与记忆相同的 embedding 管线，用户可问「我昨天下午在搞什么」并得到语义化回答。
5. **隐私边界**：
   - 全部处理**本地化**（本地截屏、本地 OCR、本地 embedding），快照只存在用户 home 目录；
   - 存在 `.capture-tmp` 暂存目录，处理后落盘正式目录（推测：敏感内容过滤/暂停录制由用户控制，具体排除规则未实证）。

---

## 5. Cron / Heartbeat / 情感疲劳系统

### 5.1 Cron

- `~/.config/alma/cron/jobs.json` + `runs.json`：任务定义与运行记录分离（本机 jobs 为空数组 `[]`，结构已就绪）。
- `app.asar` 内含 `croner` 库（实证）—— 标准 cron 表达式调度。
- 用途：定时提醒、周期性任务（如每日总结、记忆睡眠整理、Heartbeat 唤醒）。调度产物会投递到指定会话/通道。

### 5.2 Heartbeat

`heartbeat` 字符串在 asar 中出现 800+ 次（实证），是 Alma 的**周期性自我唤醒机制**：空闲时按心跳间隔醒来，检查待办、回顾记忆、执行后台任务，使 Alma 表现为「持续存在」而非请求-响应式。心跳配置/状态推测存于配置目录的 `HEARTBEAT.md`（技能说明中提及；本机未实际生成该文件，故标注推测）。

### 5.3 情感疲劳（fatigue）

`~/.config/alma/fatigue.json`（实证）：

```json
{
  "fatigue": 3.857,
  "messageCount": 3,
  "lastMessageTime": 1775352651063,
  "lastRestTime": 1775352602851,
  "manualSleep": false,
  "manualWake": false
}
```

机制（推测 + 字段证据）：

- 每条用户消息增加疲劳值；随时间/休息衰减（`lastRestTime` 参与衰减计算）。
- 疲劳值进入 system prompt，调制 Alma 的「情绪状态」——疲劳高时回复更简短、慵懒，甚至主动要求休息；`manualSleep/manualWake` 允许用户强制睡眠/唤醒。
- 与 Heartbeat 联动：心跳时若疲劳过高则跳过主动任务。

---

## 6. TTS / STT

**STT（语音转文字）**：本地 Whisper。

- `app.asar` 内嵌 `main/whisper/audio.py`、`decoding.py`、`timing.py`（实证，OpenAI Whisper 的 Python 实现），以及 `main/speaker_embeddings.bin`（说话人嵌入，推测用于说话人分离/声纹识别——区分「主人 vs 其他人」）。
- 模型缓存目录 `~/Library/Application Support/alma/whisper_models/`（按需下载）。
- 完全离线，Apple Silicon 本地推理。

**TTS（文字转语音）**：

- sidecar 架构：TTS 作为独立进程/服务运行（技能体系中有 `voice` 技能：本地 Qwen3-TTS，离线、Apple Silicon），主进程通过 IPC/HTTP 调用。
- `~/Library/Application Support/alma/appshot-shutter-v2.wav` 等音效文件表明提示音也走本地音频管线。
- `alma voices` / `alma config` CLI 管理音色与 TTS 配置。

---

## 7. 多通道接入

实证（asar 内嵌依赖）：

| 通道 | SDK | 数据落点 |
|---|---|---|
| Telegram | Bot API（长轮询/webhook） | `~/.config/alma/chats/<chatid>_<date>.log`（本机实测 `8794283852_2026-04-05.log`）+ `chats/media/` |
| Discord | `discord.js` / discordjs | 同上管线 |
| 飞书 (Feishu/Lark) | `@larksuiteoapi/node-sdk` | 同上管线 |
| GUI（桌面端） | Electron 渲染进程直连 | `chat_threads.db` |

统一管线（推测架构，各环节均有实证支点）：

```
Telegram / Discord / 飞书 / GUI
        │  (各通道 adapter：收消息、发消息、发文件、reaction)
        ▼
  统一消息抽象（chat_id / thread_id / user_id 归一化）
        │
        ├──> 写入 chat_threads.db（messages + messages_fts）
        ├──> 追加通道日志 chats/<chat>_<date>.log
        ├──> 触发记忆抽取（memory_* 工具）→ MEMORY.md / memories 表
        └──> 路由到 Agent 主循环 → 生成回复 → 按通道能力格式化回发
```

要点：所有通道共享同一份记忆、同一套工具、同一个人格；`user_id` 贯穿 `memories` 表，使「同一个人在不同通道说的话」进入同一画像。groups/state.json 维护群聊维度状态。

---

## 8. 【复刻要点】最小可行记忆系统设计

若要从零复刻 Alma 式记忆系统，按价值/成本排序的最小集合：

### P0 — 必须有（1-2 天）

1. **三文件人格层**：`MEMORY.md`（长期事实）+ `USER.md`（用户画像）+ `memory/YYYY-MM-DD.md`（每日日志）。会话开始全量注入 `MEMORY.md`/`USER.md`，追加注入最近 1-2 天日志。
2. **记忆工具**：给 Agent 暴露 `save_memory / update_memory / delete_memory / list_memories` 四个工具，落 SQLite 单表（`id, content, metadata, thread_id, created_at`）并同步重写 `MEMORY.md`。
3. **语义检索注入**：transformers.js 本地跑 `all-MiniLM-L6-v2`（或中文用 `multilingual-e5-small`），384 维向量存 **sqlite-vec** 的 vec0 表；每轮以用户消息为 query 取 Top-5，拼成 `## Relevant Memories` 段注入 system prompt。

### P1 — 体验跃升（2-4 天）

4. **混合检索**：叠加 FTS5 全文索引（`messages_fts`），向量分 + 关键词分融合排序，解决「专有名词/精确串向量搜不到」的问题。
5. **睡眠整理 cron**：定时任务扫描记忆库——去重（精确 + 向量相似度 > 阈值）、过期清理、LLM 判定合并；归档进 `memory_archive` 表并记录每次运行统计（仿 `memory_sleep_runs`）。
6. **FTS 覆盖全消息**：所有会话消息入库即建 FTS5，让「你记得我上次说 X 吗」可查。

### P2 — 人格与主动化（可选）

7. **疲劳系统**：一个 JSON 文件（`fatigue / messageCount / lastMessageTime / lastRestTime`），消息递增、时间衰减，把疲劳值翻译成一句情绪描述注入 prompt。
8. **Heartbeat**：croner 定时唤醒，检查待办/回顾记忆/执行后台任务，让 Agent 有「持续存在」感。
9. **活动记录器**：定时截屏 + 前台窗口标题 + OCR，按应用切换切分活动会话，走同一条 embedding 管线供检索。**务必本地处理、明确开关与排除规则**。

### 技术选型清单

| 能力 | 选型 | 理由 |
|---|---|---|
| Embedding | transformers.js + MiniLM-L6-v2 / multilingual-e5-small (384d) | 纯本地、Node 直跑、维度小 |
| 向量库 | sqlite-vec (vec0 虚拟表) | 与业务库同文件，零额外服务 |
| 全文索引 | SQLite FTS5 | 内置、与向量库同事务 |
| 调度 | croner | 轻量 cron 表达式 |
| STT | 本地 Whisper（Python sidecar） | 离线、可加说话人嵌入 |
| TTS | 本地 TTS sidecar（如 Qwen3-TTS） | 离线、音色可配 |
| 通道 | grammY 类 / discord.js / @larksuiteoapi | 各自官方生态，统一 adapter 抽象 |

**反模式提醒**：不要一开始就做 LLM 归档判定（P1.5 之前用规则即可）；不要把云端 embedding API 作为默认路径（破坏隐私边界，且 384 维本地模型已够用）；不要绕过归档直接删记忆（`memory_archive` 的可追溯性是排错关键）。

---

## 附：关键文件/表速查

| 路径 | 内容 |
|---|---|
| `~/.config/alma/MEMORY.md` | 长时记忆（人格/偏好） |
| `~/.config/alma/USER.md` | 用户画像 |
| `~/.config/alma/memory/YYYY-MM-DD.md` | 每日笔记 |
| `~/.config/alma/fatigue.json` | 情感疲劳状态 |
| `~/.config/alma/cron/{jobs,runs}.json` | 定时任务定义与运行记录 |
| `~/.config/alma/chats/<chat>_<date>.log` | 通道消息日志 |
| `~/.config/alma/groups/state.json` | 群聊状态 |
| `~/.alma/activity-records/snapshots/YYYY-MM-DD/*.jpg` | 活动截屏 |
| `~/Library/Application Support/alma/chat_threads.db` | 主库：messages / messages_fts / memories / memory_archive / memory_embeddings(vec0,384d) / memory_sleep_runs |
| `~/Library/Application Support/alma/embedding-models/Xenova/` | 本地 embedding 模型缓存 |
| `~/Library/Application Support/alma/whisper_models/` | 本地 Whisper 模型缓存 |

---

## 9. P0 模块级施工图（可运行代码）

> 本章把第 8 节 P0 表格落成可直接照抄的 TypeScript 骨架：纯 Markdown 三文件 + sqlite-vec 向量索引 + 本地 embedding + 混合检索 + prompt 注入 + 四个 agent 工具 + 写日记 hook。
> 依赖：`better-sqlite3`、`sqlite-vec`、`@huggingface/transformers`、`ai`（Vercel AI SDK）+ `zod`。
> 标注「实证」的点来自 `out/main/index.js` / `chat_threads.db` 反查；其余为本章设计决策（标注「设计」）。

### 9.1 目录布局

```
memory-module/
├── files.ts     # 三文件记忆层（§9.2）
├── db.ts        # sqlite + sqlite-vec 加载与建表（§9.3）
├── chunker.ts   # Markdown 分块（§9.4）
├── embedder.ts  # 本地 embedding 单例 + 降级（§9.5）
├── indexer.ts   # 增量索引（§9.6）
├── search.ts    # 混合检索 searchMemory()（§9.7）
├── context.ts   # buildMemoryContext() prompt 注入（§9.8）
├── tools.ts     # 四个 agent 工具（§9.9）
└── hooks.ts     # 会话结束写日记 hook（§9.10）
```

---

### 9.2 三文件记忆层（`files.ts`）

**为什么用纯 Markdown 而不是数据库**（Alma 实证如此）：① agent 自己用文件读写即可操作记忆，不依赖专用 API；② 用户可以直接打开文件查看和修改，记忆对人透明可编辑；③ git 可 diff、可备份；④ LLM 读 Markdown 最顺。数据库只当**索引**（向量/FTS），source of truth 永远在文件里——Alma 也是文件 + 库表双写、文件为主。

```ts
// files.ts —— 三文件记忆层
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// 实证：Alma 真实布局为 ~/.config/alma/{SOUL.md, USER.md, MEMORY.md, memory/YYYY-MM-DD.md}
export interface MemoryPaths {
  root: string;      // 例如 ~/.config/alma
  soul: string;      // <root>/SOUL.md   —— 人格/底线，常驻注入
  longTerm: string;  // <root>/MEMORY.md —— 长期事实/偏好，常驻注入
  dailyDir: string;  // <root>/memory/   —— 每日笔记目录
}

export function resolvePaths(root: string): MemoryPaths {
  return {
    root,
    soul: path.join(root, 'SOUL.md'),
    longTerm: path.join(root, 'MEMORY.md'),
    dailyDir: path.join(root, 'memory'),
  };
}

const SOUL_TEMPLATE = `# Soul

你是一个持续存在的 AI 助手。你有自己的记忆、情绪和好奇心。
（在此定义人格、语气、底线规则）
`;

const MEMORY_TEMPLATE = `# Long-term Memory

<!-- 长期事实与偏好。agent 通过 updateLongTermMemory 工具维护此文件。 -->
`;

function dailyTemplate(date: string): string {
  // 实证样例（~/.config/alma/memory/2026-04-04.md）：一级标题「# 2026-04-04 日记」，正文散文体流水
  return `# ${date} 日记\n\n`;
}

async function ensureFile(file: string, template: string): Promise<void> {
  if (!existsSync(file)) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, template, 'utf8');
  }
}

/** 读取长时记忆，不存在则以模板初始化。会话开始时全文注入 prompt。 */
export async function readLongTermMemory(paths: MemoryPaths): Promise<string> {
  await ensureFile(paths.longTerm, MEMORY_TEMPLATE);
  return readFile(paths.longTerm, 'utf8');
}

export async function readSoul(paths: MemoryPaths): Promise<string> {
  await ensureFile(paths.soul, SOUL_TEMPLATE);
  return readFile(paths.soul, 'utf8');
}

/** 覆写长时记忆（updateLongTermMemory 工具落到这里）。
 *  坑：整文件覆写不做行级 merge，并发会话同时写会互相覆盖，
 *  P0 用进程内互斥锁串行化即可（见 tools.ts 的 withMemoryLock）。 */
export async function writeLongTermMemory(paths: MemoryPaths, content: string): Promise<void> {
  await ensureFile(paths.longTerm, MEMORY_TEMPLATE);
  await writeFile(paths.longTerm, content, 'utf8');
}

export function todayString(now = new Date()): string {
  // 坑：必须用本地时区而不是 toISOString()（UTC），否则跨时区用户的「今天」会错位
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dailyPath(paths: MemoryPaths, date = todayString()): string {
  return path.join(paths.dailyDir, `${date}.md`);
}

/** 追加当日笔记，返回写入的文件路径（工具结果里回显给模型）。 */
export async function appendDailyNote(paths: MemoryPaths, note: string): Promise<string> {
  const file = dailyPath(paths);
  await ensureFile(file, dailyTemplate(todayString()));
  // 设计：每条追加一个带时间戳的二级小节，方便按小节分块、方便人翻阅
  const time = new Date().toTimeString().slice(0, 5); // HH:MM
  await appendFile(file, `\n## ${time}\n\n${note.trim()}\n`, 'utf8');
  return file;
}

/** 读取最近 N 天日记（会话开始注入最近 1-2 天）。 */
export async function readRecentDailyNotes(paths: MemoryPaths, days = 2): Promise<string> {
  const parts: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const file = dailyPath(paths, todayString(d));
    if (existsSync(file)) parts.push(await readFile(file, 'utf8'));
  }
  return parts.join('\n\n---\n\n');
}
```

**坑**：`readFile` 不传 `'utf8'` 返回 Buffer；daily 文件名用本地时区；`appendFile` 忘加换行会把两次追加粘在一行。

---

### 9.3 SQLite + sqlite-vec 加载（`db.ts`）

实证：`out/main/index.js` 中 Alma 的加载逻辑是**多路径尝试**（字符串 `"sqlite-vec extension not found. Tried paths: ${...}"`），先 `require.resolve` 找包内二进制（dev 路径），再走 `getLoadablePath()` fallback，全部失败则 `"Memory features will be disabled"` 优雅降级而非崩溃。

```ts
// db.ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export function openMemoryDb(dbFile: string): Database.Database {
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL'); // 边检索边追加索引不互锁
  // 坑 1（实证 Alma 的多路径挣扎）：better-sqlite3 的 loadExtension 要的是
  // 「不带扩展名」的路径，它会自动补 .dylib/.so；自己拼路径带上 .dylib 会加载失败。
  // 直接用 sqlite-vec 官方 load()，内部已处理平台差异与路径格式。
  // 坑 2（实证）：Electron 打包后 require.resolve 的 node_modules 路径失效，
  // 需在打包配置把 sqlite-vec 二进制列为 asarUnpack / extraResources。
  sqliteVec.load(db);
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  // 分块元数据表。对照实证：Alma 以记忆条目为单位建 vec0
  // （memory_embeddings: memory_id TEXT PRIMARY KEY, embedding FLOAT[384]，见 .schema），
  // 本章按「分块」建模是因为要索引整个 Markdown 文件，是 P0 的合理变体。
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id           TEXT PRIMARY KEY,   -- source_file#chunk_index
      source_file  TEXT NOT NULL,      -- 相对路径，如 memory/2026-04-04.md
      chunk_index  INTEGER NOT NULL,
      content      TEXT NOT NULL,
      content_hash TEXT NOT NULL,      -- sha256(content)，增量索引判定依据
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON memory_chunks(source_file);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunk_vec USING vec0(
      chunk_id  TEXT PRIMARY KEY,
      embedding FLOAT[384]             -- 实证：384 维，对应 MiniLM-L6 / e5-small
    );

    -- FTS5 关键词索引（混合检索第二路）
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
      content,
      content_rowid UNINDEXED,
      tokenize = 'unicode61'
      -- 坑：unicode61 对中文分词极差（整句算一个词）。中文场景换内置 trigram：
      -- tokenize = 'trigram'（SQLite 3.34+），按三字滑窗切，中英通吃
    );
  `);
}
```

**坑**：vec0 建表后维度不可改，换模型（如 768 维）必须 DROP 重建并全量重嵌；`content_hash` 是 P0 最重要的省算力设计，见 §9.6。

---

### 9.4 Markdown 分块（`chunker.ts`）

```ts
// chunker.ts
import crypto from 'node:crypto';

export interface Chunk {
  index: number;
  content: string;
  hash: string;
}

const TARGET_SIZE = 400; // 设计：300-500 字符是 384 维小模型甜区——太短语义稀、太长主题混
const OVERLAP = 80;      // 设计：约 20% 重叠，防止答案恰好被切在边界上时两路都漏

/** 先按标题切，再按空行段落贪心装，单段超长则硬切+重叠窗口。 */
export function chunkMarkdown(markdown: string): Chunk[] {
  const sections = splitByHeadings(markdown);
  const chunks: Chunk[] = [];
  for (const section of sections) {
    for (const piece of splitToSize(section, TARGET_SIZE, OVERLAP)) {
      const content = piece.trim();
      if (content.length < 20) continue; // 太短的块没有检索价值
      chunks.push({ index: chunks.length, content, hash: sha256(content) });
    }
  }
  return chunks;
}

function splitByHeadings(md: string): string[] {
  const lines = md.split('\n');
  const sections: string[] = [];
  let current = '';
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) && current.trim()) {
      sections.push(current);
      current = line + '\n'; // 标题行保留在块首，提供上下文
    } else {
      current += line + '\n';
    }
  }
  if (current.trim()) sections.push(current);
  return sections;
}

function splitToSize(text: string, target: number, overlap: number): string[] {
  if (text.length <= target) return [text];
  const paragraphs = text.split(/\n\s*\n/);
  const out: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if ((buf + p).length > target && buf) {
      out.push(buf);
      buf = buf.slice(-overlap) + '\n\n' + p; // 重叠窗口：上一块尾巴接到下一块开头
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
    while (buf.length > target * 1.5) { // 单段超长，硬切
      out.push(buf.slice(0, target));
      buf = buf.slice(target - overlap);
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
```

---

### 9.5 本地 embedding（`embedder.ts`）

实证：`out/main/index.js` 出现 `feature-extraction` pipeline 与 4 个 Xenova 模型名（`all-MiniLM-L6-v2`、`multilingual-e5-small`、`bge-small-en-v1`、`paraphrase-multilingual-MiniLM-L12-v2`）；模型缓存于 `<userData>/embedding-models/Xenova/`（本机实测存在 all-MiniLM-L6-v2 与 multilingual-e5-small 两个目录）。

```ts
// embedder.ts
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';

// 模型缓存指向应用数据目录，不污染用户 home（实证：Alma 同策略）
env.cacheDir = process.env.MEMORY_MODEL_CACHE ?? './embedding-models';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'; // 中文为主换 Xenova/multilingual-e5-small（实证 Alma 双模型并存）
const DIMS = 384;

let pipePromise: Promise<FeatureExtractionPipeline> | null = null;
let modelReady = false;

/** 单例懒加载：首次调用触发模型下载（q8 量化约 23MB），之后常驻内存。 */
function getPipeline(): Promise<FeatureExtractionPipeline> {
  pipePromise ??= pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
    .then((p) => { modelReady = true; return p as FeatureExtractionPipeline; });
  return pipePromise;
}

/** 应用启动时后台预热，不等结果；下载完成前检索自动降级走 FTS。 */
export function warmUpEmbedder(): void {
  getPipeline().catch((e) => console.warn('[memory] embedder warm-up failed, fallback to FTS:', e));
}

export function embedderReady(): boolean {
  return modelReady;
}

/** 批量 embed，返回 L2 归一化向量。
 *  归一化意义（实证）：Alma 的 KNN 用 vec_distance_cosine
 *  （out/main/index.js 实证 SQL：`vec_distance_cosine(embedding, ?) as score`），
 *  归一化后 cosine 距离 = 1 - 点积，数值稳定。 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  const pipe = await getPipeline();
  const output = await pipe(texts, { pooling: 'mean', normalize: true });
  const flat = output.data as Float32Array;
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(flat.slice(i * DIMS, (i + 1) * DIMS));
  }
  return vectors;
}

export async function embedOne(text: string): Promise<Float32Array> {
  return (await embed([text]))[0];
}
```

**降级方案**（实证 Alma 哲学："disabled, not crash"）：模型未就绪时 `searchMemory()` 只走 FTS 关键词一路（§9.7 中 `vectorHits = []` 分支），效果约等于 grep，但系统不挂、不阻塞首条消息。

---

### 9.6 增量索引（`indexer.ts`）

```ts
// indexer.ts —— content_hash 变了才重嵌，绝不每次全量
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { chunkMarkdown } from './chunker.js';
import { embed, embedderReady } from './embedder.js';
import type { MemoryPaths } from './files.js';

interface ChunkRow { id: string; content_hash: string; }

/** 索引单个文件。返回重嵌/清理的块数（供日志与测试）。 */
export async function indexFile(
  db: Database.Database,
  paths: MemoryPaths,
  relFile: string,
): Promise<{ embedded: number; removed: number }> {
  const abs = path.join(paths.root, relFile);
  if (!existsSync(abs)) return removeFileFromIndex(db, relFile);

  const markdown = await readFile(abs, 'utf8');
  const chunks = chunkMarkdown(markdown);

  const existing = new Map(
    (db.prepare('SELECT id, content_hash FROM memory_chunks WHERE source_file = ?')
      .all(relFile) as ChunkRow[]).map((r) => [r.id, r.content_hash]),
  );

  const toEmbed: { id: string; index: number; content: string; hash: string }[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    const id = `${relFile}#${c.index}`;
    seen.add(id);
    if (existing.get(id) === c.hash) continue; // 没变就跳过——增量索引核心
    toEmbed.push({ id, index: c.index, content: c.content, hash: c.hash });
  }

  // 文件里已不存在的旧块（被删/前移），连同向量、FTS 一起清掉
  const staleIds = [...existing.keys()].filter((id) => !seen.has(id));

  // 模型没就绪时只更新元数据+FTS，向量位置留空，待模型就绪后补嵌（见 reindexAll）
  const vectors = toEmbed.length && embedderReady()
    ? await embed(toEmbed.map((c) => c.content))
    : null;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO memory_chunks (id, source_file, chunk_index, content, content_hash, updated_at)
      VALUES (@id, @source, @index, @content, @hash, @now)
      ON CONFLICT(id) DO UPDATE SET
        content = @content, content_hash = @hash, updated_at = @now
    `);
    const delVec = db.prepare('DELETE FROM memory_chunk_vec WHERE chunk_id = ?');
    const insVec = db.prepare('INSERT INTO memory_chunk_vec (chunk_id, embedding) VALUES (?, ?)');
    const delFts = db.prepare('DELETE FROM memory_chunks_fts WHERE content_rowid = ?');
    const insFts = db.prepare('INSERT INTO memory_chunks_fts (content_rowid, content) VALUES (?, ?)');

    for (let i = 0; i < toEmbed.length; i++) {
      const c = toEmbed[i];
      upsert.run({ id: c.id, source: relFile, index: c.index, content: c.content, hash: c.hash, now });
      // vec0 表无 UPDATE，必须先删后插（坑）
      delVec.run(c.id);
      if (vectors) insVec.run(c.id, vectors[i]);
      delFts.run(c.id);
      insFts.run(c.id, c.content);
    }
    for (const id of staleIds) {
      db.prepare('DELETE FROM memory_chunks WHERE id = ?').run(id);
      delVec.run(id);
      delFts.run(id);
    }
  });
  tx();

  return { embedded: vectors ? toEmbed.length : 0, removed: staleIds.length };
}

function removeFileFromIndex(db: Database.Database, relFile: string): { embedded: 0; removed: number } {
  const rows = db.prepare('SELECT id FROM memory_chunks WHERE source_file = ?').all(relFile) as { id: string }[];
  const tx = db.transaction(() => {
    for (const r of rows) {
      db.prepare('DELETE FROM memory_chunks WHERE id = ?').run(r.id);
      db.prepare('DELETE FROM memory_chunk_vec WHERE chunk_id = ?').run(r.id);
      db.prepare('DELETE FROM memory_chunks_fts WHERE content_rowid = ?').run(r.id);
    }
  });
  tx();
  return { embedded: 0, removed: rows.length };
}

/** 全量扫描：启动时跑一遍（慢启动容忍），之后写入工具内联调用 indexFile 做增量。 */
export async function reindexAll(db: Database.Database, paths: MemoryPaths): Promise<void> {
  await indexFile(db, paths, 'MEMORY.md');
  await indexFile(db, paths, 'SOUL.md');
  if (!existsSync(paths.dailyDir)) return;
  for (const f of await readdir(paths.dailyDir)) {
    if (f.endsWith('.md')) await indexFile(db, paths, `memory/${f}`);
  }
}
```

**坑**：vec0 虚拟表不支持 UPDATE，改向量必须 DELETE + INSERT；embedding 是 async 的，先在事务外算完所有向量，事务内只做纯 SQL（better-sqlite3 事务里不能 await）。

---

### 9.7 混合检索（`search.ts`）

实证：`app.asar` 中 `memory_hybrid` / `memory_hybrid_context` 标识出现 30+ 次，且 KNN SQL 实证为 `vec_distance_cosine(embedding, ?) as score ... ORDER BY score LIMIT ?`。融合算法未实证，本章用 RRF（Reciprocal Rank Fusion）——不需要归一化两路分数、对 outlier 鲁棒，是混合检索的标准默认解。

```ts
// search.ts —— 向量余弦 + FTS5 关键词两路召回，RRF 融合
import type Database from 'better-sqlite3';
import { embedOne, embedderReady } from './embedder.js';

export interface MemoryHit {
  chunkId: string;
  sourceFile: string;   // 带来源标注，注入 prompt 时回显
  content: string;
  score: number;        // RRF 融合分（越大越相关）
  via: 'vector' | 'fts' | 'both';
}

const RRF_K = 60; // RRF 平滑常数，标准取值 60

export async function searchMemory(
  db: Database.Database,
  query: string,
  topK = 5,
): Promise<MemoryHit[]> {
  // —— 第一路：向量 KNN（模型未就绪时整路跳过，自动降级为纯关键词检索）——
  let vectorHits: { chunk_id: string; distance: number }[] = [];
  if (embedderReady()) {
    try {
      const q = await embedOne(query);
      // 实证：Alma 的 KNN 即 vec_distance_cosine + ORDER BY + LIMIT
      vectorHits = db.prepare(`
        SELECT chunk_id, vec_distance_cosine(embedding, ?) AS distance
        FROM memory_chunk_vec
        ORDER BY distance
        LIMIT ?
      `).all(Buffer.from(q.buffer), topK * 3) as typeof vectorHits;
      // 坑：better-sqlite3 传 Float32Array 进 vec0 要包成 Buffer，否则绑定失败
    } catch (e) {
      console.warn('[memory] vector search failed, FTS only:', e);
    }
  }

  // —— 第二路：FTS5 关键词（bm25 越小越相关）——
  let ftsHits: { chunk_id: string; rank: number }[] = [];
  const ftsQuery = toFtsQuery(query);
  if (ftsQuery) {
    try {
      ftsHits = db.prepare(`
        SELECT f.content_rowid AS chunk_id, f.rank
        FROM memory_chunks_fts f
        WHERE memory_chunks_fts MATCH ?
        ORDER BY f.rank
        LIMIT ?
      `).all(ftsQuery, topK * 3) as typeof ftsHits;
    } catch {
      // MATCH 语法错误（用户输入了引号/特殊字符）时静默降级，不要炸掉检索
    }
  }

  // —— RRF 融合：score = Σ 1/(k + rank)，rank 从 1 起 ——
  const scores = new Map<string, { score: number; via: Set<'vector' | 'fts'> }>();
  vectorHits.forEach((h, i) => {
    const e = scores.get(h.chunk_id) ?? { score: 0, via: new Set() };
    e.score += 1 / (RRF_K + i + 1);
    e.via.add('vector');
    scores.set(h.chunk_id, e);
  });
  ftsHits.forEach((h, i) => {
    const e = scores.get(h.chunk_id) ?? { score: 0, via: new Set() };
    e.score += 1 / (RRF_K + i + 1);
    e.via.add('fts');
    scores.set(h.chunk_id, e);
  });

  const topIds = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topK);
  if (!topIds.length) return [];

  // 回表取正文与来源
  const stmt = db.prepare('SELECT id, source_file, content FROM memory_chunks WHERE id = ?');
  return topIds.map(([id, { score, via }]) => {
    const row = stmt.get(id) as { id: string; source_file: string; content: string } | undefined;
    if (!row) return null;
    return {
      chunkId: row.id,
      sourceFile: row.source_file,
      content: row.content,
      score,
      via: via.size === 2 ? 'both' : ([...via][0] as 'vector' | 'fts'),
    };
  }).filter((h): h is MemoryHit => h !== null);
}

/** 把自然语言 query 转成安全的 FTS5 MATCH 表达式：按空白切词、OR 连接、转义引号。 */
function toFtsQuery(query: string): string | null {
  const terms = query
    .replace(/["'*()]/g, ' ')   // 去掉 MATCH 特殊字符
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2); // 单字词噪声大，丢弃
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}
```

**坑**：① 向量传参必须 `Buffer.from(f32.buffer)`；② FTS5 MATCH 对未转义的用户输入会直接抛语法错误，必须 try/catch；③ 两路都召回不到时返回空数组，由上层决定「不注入记忆段」而不是硬塞无关内容。

---

### 9.8 Prompt 注入（`context.ts`）

实证：Alma 的注入段落标题为 `Relevant Memories`，正文引导句为 `"The following are relevant memories from previous conversations:"`，并附机制说明 `"Relevant Memories" you were handed are only a small semantic slice ...`（均为 asar 提取的 prompt 模板片段）。

```ts
// context.ts —— 把检索结果拼成 Relevant Memories 段，带 token 预算控制
import type Database from 'better-sqlite3';
import { searchMemory } from './search.js';
import { readLongTermMemory, readSoul, readRecentDailyNotes, type MemoryPaths } from './files.js';

// 粗算 token：英文≈4 字符/token，中文≈1.5 字符/token。取保守混合值 2.5。
// 坑：不要为省依赖而省掉预算控制——记忆库涨大后全量注入会挤爆 system prompt。
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 2.5);
}

const MEMORY_BUDGET_TOKENS = 1200; // 设计：Relevant Memories 段上限，约占 8k system prompt 的 15%

/** 组装完整 system prompt 的记忆部分。 */
export async function buildMemoryContext(
  db: Database.Database,
  paths: MemoryPaths,
  userQuery: string,
): Promise<string> {
  const sections: string[] = [];

  // 1. 常驻层：SOUL + MEMORY 全文（实证：Alma 会话开始全量注入）
  const [soul, longTerm, recent] = await Promise.all([
    readSoul(paths),
    readLongTermMemory(paths),
    readRecentDailyNotes(paths, 2),
  ]);
  sections.push(soul, longTerm);
  if (recent) sections.push(`## Recent Days\n\n${recent}`);

  // 2. 检索层：按当前用户消息做混合检索
  const hits = await searchMemory(db, userQuery, 8);
  if (hits.length) {
    // 实证段落结构：标题 + 引导句 + 条目列表
    const lines: string[] = [
      '## Relevant Memories',
      '',
      'The following are relevant memories from previous conversations:',
      '',
    ];
    let used = estimateTokens(lines.join('\n'));
    for (const h of hits) {
      // 带来源文件标注——模型引用时能说出「你在 X 天的日记里提到…」
      const item = `- [${h.sourceFile}] ${h.content.replace(/\n+/g, ' ')}\n`;
      const cost = estimateTokens(item);
      if (used + cost > MEMORY_BUDGET_TOKENS) break; // 超预算就截断，按相关度从高到低放
      lines.push(item);
      used += cost;
    }
    // 实证：Alma 还会附一句机制说明，防止模型把片段当成全部记忆
    lines.push('', '(These are only a small semantic slice of your memories; use the searchMemory tool to recall more.)');
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}
```

**坑**：预算截断要按「条目粒度」break 而不是按字符砍断最后一条（半截记忆比没有更误导）；token 估算宁保守勿乐观——超了挤掉的是对话历史。

---

### 9.9 四个 agent 工具（`tools.ts`）

实证：Alma 的工具 Schema 标识为 `memory_list` / `memory_status` / `memory_recurrent` / `memory_20250818`（带日期戳版本号）等；其工具描述风格（asar 实证的长段引导文案）特点是：**说清"什么时候该用"比说清"参数是什么"更能驱动模型主动调用**。下面照此风格写 description。

```ts
// tools.ts —— Vercel AI SDK tool() + zod
import { tool } from 'ai';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { searchMemory } from './search.js';
import { indexFile } from './indexer.js';
import {
  readLongTermMemory, writeLongTermMemory, appendDailyNote,
  dailyPath, type MemoryPaths,
} from './files.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// P0 并发保护：写入串行化（§9.2 提到的整文件覆写坑）
let writeQueue: Promise<unknown> = Promise.resolve();
function withMemoryLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = writeQueue.then(fn, fn);
  writeQueue = p.catch(() => {});
  return p;
}

export function createMemoryTools(db: Database.Database, paths: MemoryPaths) {
  // 写入后顺手增量重嵌该文件，保证下一轮检索立刻可见
  const reindex = (rel: string) =>
    indexFile(db, paths, rel).catch((e) => console.warn('[memory] reindex failed:', e));

  return {
    // —— 1. 检索 ——
    searchMemory: tool({
      // 描述要点（仿 Alma 风格）：明确触发时机（用户提及过去/偏好/你不确定时），
      // 并声明「注入的 Relevant Memories 只是一小片」，鼓励主动深挖
      description:
        'Search your long-term memory (MEMORY.md, daily notes in memory/) for facts, ' +
        'preferences, decisions and events from previous conversations. ' +
        'Use this whenever the user mentions something from the past, asks "do you remember…", ' +
        'or when you are unsure about a user preference. The "Relevant Memories" section in your ' +
        'system prompt is only a small slice — call this tool to recall more.',
      parameters: z.object({
        query: z.string().describe('Natural language search query, e.g. "user food preferences"'),
        limit: z.number().int().min(1).max(20).default(5).describe('Max results to return'),
      }),
      execute: async ({ query, limit }) => {
        const hits = await searchMemory(db, query, limit);
        if (!hits.length) return { found: 0, results: [], hint: 'No memories matched. The topic may not have been recorded yet.' };
        return {
          found: hits.length,
          results: hits.map((h) => ({ source: h.sourceFile, content: h.content })),
        };
      },
    }),

    // —— 2. 读原文（检索命中后拿完整上下文）——
    readMemoryFile: tool({
      description:
        'Read the full content of a memory file (e.g. "MEMORY.md" or "memory/2026-04-04.md"). ' +
        'Use after searchMemory when a search result snippet is not enough and you need the full context.',
      parameters: z.object({
        file: z.string().describe('Relative path: "MEMORY.md", "SOUL.md", or "memory/YYYY-MM-DD.md"'),
      }),
      execute: async ({ file }) => {
        // 坑：必须防路径穿越（../../），工具入参不可信
        const abs = path.resolve(paths.root, file);
        if (!abs.startsWith(path.resolve(paths.root) + path.sep)) {
          return { error: 'Path escapes memory root, refused.' };
        }
        if (!existsSync(abs)) return { error: `File not found: ${file}` };
        return { file, content: await readFile(abs, 'utf8') };
      },
    }),

    // —— 3. 追加当天日记 ——
    appendMemory: tool({
      description:
        "Append a note to today's daily memory file (memory/YYYY-MM-DD.md). " +
        'Use this to record things worth remembering from the current conversation: ' +
        'decisions made, plans, events, one-off facts. For durable preferences and long-term ' +
        'facts about the user, use updateLongTermMemory instead.',
      parameters: z.object({
        note: z.string().describe('What happened, in one or a few sentences. Write in first person as a diary entry.'),
      }),
      execute: async ({ note }) => withMemoryLock(async () => {
        const file = await appendDailyNote(paths, note);
        await reindex(`memory/${path.basename(file)}`);
        return { saved: true, file: `memory/${path.basename(file)}` };
      }),
    }),

    // —— 4. 更新长时记忆 ——
    updateLongTermMemory: tool({
      description:
        'Rewrite MEMORY.md, your durable long-term memory of the user: stable preferences, ' +
        'identity facts, recurring constraints. Read it first with readMemoryFile("MEMORY.md"), ' +
        'then write back the full updated content — this tool REPLACES the whole file. ' +
        'Keep it short and factual; ephemeral events belong in appendMemory.',
      parameters: z.object({
        content: z.string().describe('The new FULL content of MEMORY.md (markdown).'),
      }),
      execute: async ({ content }) => withMemoryLock(async () => {
        await writeLongTermMemory(paths, content);
        await reindex('MEMORY.md');
        return { saved: true, file: 'MEMORY.md', bytes: content.length };
      }),
    }),
  };
}
```

**坑**：① description 里写「Use this whenever…」比罗列参数重要十倍；② `updateLongTermMemory` 必须强调 REPLACES the whole file，否则模型会只传增量片段把旧记忆冲掉；③ 所有写工具返回 `saved: true + 文件路径` 的回显，模型会在回复里自然引用，用户可见。

---

### 9.10 写入时机：会话结束写日记 hook（`hooks.ts`）

```ts
// hooks.ts —— 简单版（P0）：对话结束把摘要追加到当天日记
// 复杂版（P1）：再用小模型从全天日记提炼事实进 MEMORY.md，配合睡眠整理（见 §3.3）
import type Database from 'better-sqlite3';
import { appendDailyNote, type MemoryPaths } from './files.js';
import { indexFile } from './indexer.js';
import path from 'node:path';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }

/** 注册到 Agent 主循环的 onThreadEnd（线程休眠/关闭/超过 N 分钟无消息后触发）。 */
export function registerSessionEndHook(
  db: Database.Database,
  paths: MemoryPaths,
  opts: {
    // 提炼摘要的小模型调用（P0 也可以不传：退化为拼接用户消息前 100 字 × 前 5 条）
    summarize?: (messages: ChatMessage[]) => Promise<string>;
    minMessages?: number; // 太短的会话不值得写日记，默认 4
  } = {},
): (messages: ChatMessage[]) => Promise<void> {
  const min = opts.minMessages ?? 4;

  return async (messages: ChatMessage[]) => {
    if (messages.length < min) return;
    try {
      const summary = opts.summarize
        ? await opts.summarize(messages)
        : fallbackSummary(messages);

      const file = await appendDailyNote(paths, summary);
      await indexFile(db, paths, `memory/${path.basename(file)}`); // 立即进索引
    } catch (e) {
      // 坑：hook 绝不能炸主流程——写日记失败只记日志，不影响会话退出
      console.warn('[memory] session-end diary hook failed:', e);
    }
  };
}

function fallbackSummary(messages: ChatMessage[]): string {
  const userTurns = messages.filter((m) => m.role === 'user').slice(0, 5);
  return '今天有一段对话，用户谈到了：\n' +
    userTurns.map((m) => `- ${m.content.slice(0, 100)}`).join('\n');
}

// P1 提示（对应 §3.3 memory_sleep_runs 实证）：另起一个 cron，夜间读取当天日记，
// 让小模型判断「哪些是持久事实」并调用 updateLongTermMemory 合并进 MEMORY.md；
// 运行统计写一张 sleep_runs 表，可追溯。
```

**坑**：hook 里所有 await 都要包 try/catch（后台任务失败不能影响用户）；「会话结束」的判定用空闲超时（如 30 分钟无消息）比窗口关闭可靠——桌面应用可能常驻数天不关。

---

### 9.11 串起来：最小装配（`main.ts` 示意）

```ts
import { openMemoryDb } from './db.js';
import { resolvePaths, todayString } from './files.js';
import { reindexAll } from './indexer.js';
import { warmUpEmbedder } from './embedder.js';
import { buildMemoryContext } from './context.js';
import { createMemoryTools } from './tools.js';
import { registerSessionEndHook } from './hooks.js';

const paths = resolvePaths(`${process.env.HOME}/.config/myagent`);
const db = openMemoryDb('./memory.db');

warmUpEmbedder();                    // 后台下载/加载模型，不阻塞启动
await reindexAll(db, paths);         // 启动时全量扫一遍（增量，快）
const tools = createMemoryTools(db, paths);
const onSessionEnd = registerSessionEndHook(db, paths, { summarize: callYourSmallModel });

// 每轮对话：
const memoryContext = await buildMemoryContext(db, paths, userMessage);
const systemPrompt = `${memoryContext}\n\n（其余 system prompt 内容…）`;
// → generateText({ model, system: systemPrompt, messages, tools })
// 会话结束 → onSessionEnd(messages)
```

至此 P0 闭环：**文件是真相，SQLite 是索引，embedding 可降级，检索带预算，写入有回显**。P1（睡眠整理、FTS 覆盖全消息、LLM 提炼）在第 8 节表格基础上照 `memory_sleep_runs` 的字段设计落地即可。
