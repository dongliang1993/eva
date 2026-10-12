# 谁拥有哪份状态

> **这是当前事实，不是目标。** 最后一次逐项对照代码：2026-10-12。
> 加一份新状态时先在这张表里给它找到一个所有者 —— 找不到，说明模块划分要先想清楚。

三条判定规则（[ADR C4](../adr/0004-single-owner-per-state.md)、[C5](../adr/0005-derive-instead-of-duplicate.md)）：

- **事实源只有一个。** 其他地方的同名数据都是投影，必须能从事实源重建。
- **跨模块写入必须调对方的公开命令**，不许直接改别人的表。
- **进程崩溃后无法恢复的内存状态，不能作为业务终态依据。**

## 持久化事实源（SQLite，`~/.eva/eva.db`）

18 张 drizzle 表（另有 `messages_fts` 与 `memories_fts` 两张 FTS5 虚表在迁移里建），
`db/schema.ts` 是唯一定义处，迁移在 `db/migrations/`（**不按模块拆**：migration 语义不能动）。

| 领域 | 事实源 | 投影 / 内存态 | 唯一写入者 | 代码位置 |
|---|---|---|---|---|
| 会话基本信息 | `sessions` | 侧栏查询结果 | Sessions | `modules/sessions/{session.ts,session-repository.ts}` |
| 消息与分支 | `messages.message` + parent/slot/depth | 流式 message builder | Sessions | `modules/sessions/{message-tree.ts,message-repository.ts}` |
| Run 持久化终态 | `runs` | 当前请求的 run 控制流（`RunScope` 已退役） | Runs（经 `Coordinator.settle`） | `modules/runs/{run-coordinator.ts,run-repository.ts}` |
| Run 调试事实 | `run_events` | 轨迹页投影 | Observability | `modules/observability/{run-recorder.ts,run-event-repository.ts}` |
| 审批决定 | `approval_requests` | pending deferred promise、审批卡片 | Approvals | `modules/approvals/{approval-gateway.ts,approval-repository.ts}` |
| always-allow policy | `settings.security.allowAlwaysPolicies` | 进程内 key set | Approvals（经 Settings 写回） | `modules/approvals/approval-policy-store.ts` |
| Provider 配置 | `providers`（apiKey 密文 `enc:v1:…`） | `LanguageModel` 缓存 | Providers | `modules/providers/provider-repository.ts`；缓存在 `modules/runs/agent-factory.ts` |
| 应用设置 | `settings` | 每 Run 的设置快照 | Settings | `modules/settings/app-settings.ts` |
| 每会话 skill 选择 | `session_skill_selections` | 每 Run selection 快照 | Skills | `modules/skills/{select-run-skills.ts,session-skill-selection-repository.ts}` |
| 记忆（可检索） | `memories` + `memories_fts`（FTS5 trigram） | 召回上下文 | Memory | `modules/memory/{memory-repository.ts,memory-retriever.ts}` |
| 工作区 | `workspaces` | 当前会话的绑定结果 | Workspaces | `modules/workspaces/{workspace-store.ts,workspace-repository.ts}` |
| Plan Gate | `plans` + `<ws>/.eva/plan-gate/` | run-scoped gate state | Plan Gate | `modules/plan-gate/{service.ts,plan-repository.ts}` |
| 子代理任务 | `subagent_tasks` | live runner | Subagents（子 message 仍归 Sessions 写） | `modules/subagents/{subagent-runner.ts,subagent-task-repository.ts}` |
| Token 用量 | `usage_records` | UI 聚合 | Usage | `modules/usage/usage-record-repository.ts` |
| 历史压缩 | `session_compactions` | 每轮压缩后的历史 | Compact | `modules/compact/session-compaction-repository.ts` |
| 跨会话检索 | `messages` 的 `search_text`（可重建索引投影） | — | Search | `modules/search/message-search-repository.ts` |

## 文件事实源（`~/.eva/` 与工作区内）

| 领域 | 事实源 | 谁写 | 说明 |
|---|---|---|---|
| 人类可读记忆 | `~/.eva/MEMORY.md`、`~/.eva/memory/YYYY-MM-DD.md` | Memory | **用户可以直接编辑** —— 这是它存在的理由；每轮注入 prompt（8 KB 上限） |
| Skill 目录 | `~/.eva/skills/<name>/SKILL.md`（dev 态另扫 monorepo 根 `skills/`） | 用户 / 安装包 | 进程启动时加载成 catalog |
| MCP server 配置 | `~/.eva/mcp.json` | MCP（UI 增删改经 store 写回；用户也可直接编辑） | **唯一事实源**，无 DB 表；条目名即 id；env/headers 明文随配置回传（本机信任域）；写盘 tmp→rename 原子写。旧 `mcp_servers` 表由启动迁移 `migrateMcpServersToFile` 搬进文件后经 0031 删表 |
| Plan Gate 文件 | `<workspace>/.eva/plan-gate/<planId>/current.md` | Plan Gate | `.eva/.gitignore` 只忽略 `plan-gate/` |
| 加密密钥 | `~/.eva/.secret-key`（0600） | 首次启动生成 | **删了就永久解不开已存的 apiKey**（要在设置里重新输入） |
| 窗口位置 | Electron `userData/window-state.json` | Desktop `window-state.ts` | 唯一 owner 就是那个文件 |

## 只在内存里的状态（崩溃即消失，因此都不是业务终态）

| 状态 | 谁拥有 | 不变量 |
|---|---|---|
| `RunRegistry` | Runs | **刻意不持有 `sessionId`** —— 审批归属键是 `runId`；加了这个字段就会长出第二套取消语义 |
| `RunHub`（扇出） | Runs | 与 registry 同寿，是 registry entry 的私有字段，只通过 `hubFor(runId)` 暴露。不是重复状态，别合并也别拆 |
| `LanguageModel` 缓存 | Runs / `agent-factory` | key = (kind, providerId, baseURL, modelId, apiKey)；temperature 是调用参数不进 key。provider/settings 变更调 `agents.invalidate()` |
| Skill catalog | Skills（`infra.skills`） | 进程启动加载；改了 `SKILL.md` 要重启 |
| MCP 连接与工具定义 | MCP | 坏掉的 server 降级成 `state: "error"`，**永不让对话失败**；连接状态不落 `mcp.json`（重启重算） |
| pending 审批的 promise | Approvals | 只有 `stop` / 用户决策 / 进程重启能收；SSE 断连**不**取消 |
| Plan Gate run state | Plan Gate | execute 期 getter，不是 build 期快照 —— 否则「中途 enter」和「approve 后同 run 解除」都不成立 |
| SSE 订阅者集合 | Transport | 纯投影，没有持久化权威 |
| 前端 `ChatProjection` | web `use-chat` | 唯一持有者；两个子 hook 只拿 `dispatch`，不各留一份 |

## 三条最容易被"顺手"破坏的

1. **Run 的终态只有 `Coordinator.settle()` 一个出口**：成功、流式中失败、准备期失败都走它，
   最终消息、终态、记忆提取入队在同一个事务里。`runs.settle` 只改 `status = 'running'` 的行。
2. **`RunRegistry` 不认识会话**（上表已述）。
3. **`~/.eva/mcp.json` 是 MCP 配置的唯一事实源**，没有 DB 表 —— 加回一张表就会有两份配置。
