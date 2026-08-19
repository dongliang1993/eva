# R4 · 总览与执行契约

> 承接 `../r3/00-overview.md`。R1（T0–T4）、R2（T5–T10）、R3（T11–T14）已全部落地。
> 基线实证（`fadfc35`）：`pnpm typecheck` 全绿（**含 `apps/web`**，R3 T13 补上的）；`pnpm test` 34 文件 / 264 项全绿；
> `apps/desktop/release/Eva-0.1.0-arm64.dmg` 已能打出。
>
> **本轮主题：Eva 已经能装能日常用了，接下来解决"用起来撞到的两面墙"。**

---

## 0. R3 收口确认（代码实证）

| 项 | 实证 |
|---|---|
| 打包链路 | `Eva-0.1.0-arm64.dmg` 存在；`build` 串了 `web → server → server-deps → flatten:deps → rebuild:native → electron`（`flatten:deps` 是踩到 pnpm 符号链接后加的，spec §6 坑2 预警过） |
| 重新生成 | `services/message-tree.ts`（`buildActiveChain` / `resolveLeafFrom`）+ `POST /messages/:id/switch-version` + `ThreadMessage.siblingIds`；`tests/{message-tree,regenerate}.test.ts` |
| 工程小修 | `apps/web` 有 typecheck 脚本；`app.ts` 全局 `ZodError → 400`；`docs 15 §1` 四行过期状态已校订 |
| per-tool 审批 | `classifyToolRisk` 纯函数 + `alwaysAllowTools` 白名单取代全局开关 + 审批卡片风险配色 |

---

## 1. 本轮要解决的问题

### 1.1 上下文耗尽是真实任务上的第一面墙

Eva 现在的工具集是 9 个本地工具 + MCP 工具，**没有子代理**（`grep -rl "subagent\|Task(" apps packages` → 0 个文件，R1 T4 摘掉半成品后未重建）。

现有缓解手段只有两个，都是有损的：

| 手段 | 代价 |
|---|---|
| compact（proactive + reactive + LLM 摘要） | 摘要必然丢细节 |
| tool-overflow（超长输出落盘 + 摘要） | 模型要花额外一轮去续读 |

缺的是**上下文隔离**：「你去把这个模块读一遍，回来只告诉我结论」。子代理烧自己的上下文，主线程只拿一份 final answer。现在让它读一个中等模块，主上下文直接吃掉一半。

`docs/architecture/08-parallel-multi-agent.md`（511 行）是完整施工图。

### 1.2 记忆的人类可读层完全没有

`docs/architecture/00-overview.md` 把「本地优先 + 文件即数据库的可读记忆」列为**三个关键设计哲学的第一条**，而这是唯一没实现的一条：

| 层（`docs 14 §11`） | 载体 | 现状 |
|---|---|---|
| **L1 长时记忆** | `MEMORY.md` 会话开始全文注入 | ❌ |
| **L2 每日笔记** | `memory/YYYY-MM-DD.md` 最近 1–2 天注入 | ❌ |
| L3 会话归档 | `messages_fts` | ✅ |
| L4 语义索引 | `memory_embeddings`（vec0） | ✅ |

机器层（检索）比 Alma 还完整，人类层一片空白。后果很具体：**记忆全在 SQLite 里，用户没法打开编辑器读一眼、改一行。** 而 `apps/server/SOUL.md`（你写的 Eva 人格）已经证明这个机制能跑 —— 缺的只是同一个套路再走一遍。

---

## 2. R4 范围与顺序

| 任务 | 文档 | 内容 | 估时 | 依赖 |
|---|---|---|---|---|
| **T15** | [`T15-subagents.md`](./T15-subagents.md) | 子代理 fork-join（S7）：`Task` / `TaskOutput` 双原语 + 子代理消息树 + 四道成本阀 | 5–7 天 | — |
| **T16** | [`T16-memory-files.md`](./T16-memory-files.md) | 记忆人类可读层（L1/L2）：`MEMORY.md` + 日记 + 三个文件工具 | 2–3 天 | — |

两者互不依赖。建议 **T16 先做**（2–3 天见效、风险低，且它会让你在做 T15 期间就享受到"Eva 记得住事"）；也可以并行，它们没有共同文件。

### 2.1 明确不做

1. **编排模式的代码化**。`docs 08 §5` 的 council / gan-harness / rfc-DAG **全部是 SKILL.md**，主循环只认识 `Task` / `TaskOutput` 两个原语（`docs 08 §8` 三个"不做"的第三条）。T15 会附带**一个**示例编排 skill 作为"新增编排 = 写 markdown"的验收对象，不写第二个。
2. **S6 扩展宿主**。理由见 `../r3/00-overview.md` §2.1 与本轮的补充判断（§4）。
3. **记忆文件进 FTS/向量索引**。`MEMORY.md` 每轮全量注入，不需要检索；日记的检索留到 R5（T16 §6 给了 `[r5]` 记录）。
4. **Phase E 其余**（心跳 / 疲劳 / 活动记录 / 多通道 / 语音）。`docs 14 §15` 第 4 条：任何时候不许挤占主线。

---

## 3. 执行契约

**沿用 `../r1/00-overview.md` §1** + `../r2/00-overview.md` §3 的四条 + `../r3/00-overview.md` §3 的两条。开工前必读。

R4 追加两条：

1. **T15 的危险不在"并行"，在"爆炸半径"。** `docs 08 §8`：多 agent 系统翻车极少因为逻辑错，几乎全部因为钱烧穿或上下文炸。四道成本阀（便宜模型 / final answer 唯一出口 / 深度闸 + 委派白名单 / 工具集收窄）**每一道都要有测试钉住**，不是注释里写一句就算做了。

2. **子代理消息不能污染主对话链。** 与 T12 的读路径同一类风险：子代理消息和主线程消息共用 `messages` 表，一旦 `buildActiveChain` 把它们也串进去，模型就会在主上下文里看到子代理的全部中间过程 —— 这正好把 T15 想省的上下文反向炸掉，而且**不会报错**。T15 §2.4 定了过滤规则，Step 顺序也据此排。

---

## 4. 关于 S6 扩展宿主：本轮再次推迟，并建议重新评估它是否要做

R3 §2.1 已经推迟过一次。这次我把判断写得更明确，供你决策：

- **扩展宿主解决的是第三方开发者生态**。Eva 是你（或小团队）自用的 work agent，目前没有第三方。
- **`docs 07 §1` 说的"能力扩展不靠改代码"，那两条路已经通了**：Skill（写 markdown）+ MCP（接协议）。S6 的边际价值只剩「带 UI 的面板」。
- **只有一个消费者时，槽位 API 是拿它设计出来的，不是从真实负载长出来的**。`docs 09 §13` 让 S9 Git 面板当 S6 的第一个扩展，但那等于用唯一一个消费者定义平台契约。
- 因此建议：**S9 Git 面板先当普通 feature 做**（server 加 git 子路由 + 前端 diff 视图），等出现第二、第三个面板需求，再从跑通的代码里把 S6 抽出来。

如果你的目标包含"给别人用 / 让别人写扩展"，S6 的优先级完全不同 —— 这个判断需要你给方向。

---

## 5. 验收总表

| 任务 | 一句话验收 |
|---|---|
| T15 | 主 agent 能并行 fork 3 个后台子代理、逐个 join 并综合结论；子代理用 tool 槽位模型；主上下文里只有 final answer；主对话能点开看子代理完整过程；深度超限被拒；后台异常不吞、join 有超时 |
| T16 | `~/.eva/MEMORY.md` 的内容出现在 system prompt；说"我喜欢吃汉堡"后 agent 写进 MEMORY.md，**明天新会话仍记得**；用户能直接打开该文件读/改；日记按天落在 `~/.eva/memory/YYYY-MM-DD.md` |
