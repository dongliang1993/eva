# AGENTS.md

Eva 是一个本地优先的 AI agent 桌面助手，pnpm monorepo：Electron 壳把内嵌的 Fastify server
作为 utility process 拉起（只听 127.0.0.1），agent 执行内核是独立的 `packages/harness`
（Vercel AI SDK v7）。

**这份文件是操作向摘要。** 完整事实在 [`docs/current/`](./docs/current/)，冲突时以那边为准
（并把这里一起改掉 —— 不允许两份各自演化）：

| 想知道 | 读这个 |
|---|---|
| 今天的架构、模块清单、依赖方向 | [`docs/current/architecture.md`](./docs/current/architecture.md) |
| 一次对话怎么跑（五阶段、终态、审批链） | [`docs/current/run-lifecycle.md`](./docs/current/run-lifecycle.md) |
| 某份状态谁拥有、事实源在哪 | [`docs/current/data-ownership.md`](./docs/current/data-ownership.md) |
| 某条约束为什么存在 | [`docs/adr/`](./docs/adr/README.md) |

## Reference Sources

`.refrences/`（gitignored）放相关项目的只读克隆。做与它们重叠的功能时先去那里翻实现，
再从头设计：

- `.refrences/cindy/` —— XD Inc. 的桌面 + 移动 AI 客户端 monorepo（Electron 壳、agent 运行时），
  架构上离 Eva 最近。

## 目录

```text
apps/
  server/     Fastify server(桌面态被 fork 成 utility process)
  desktop/    Electron 壳
  web/        React 19 + Vite 前端(打包后由 server 托管)
packages/
  harness/    agent 内核:模型、工具循环、prompt、skill
  shared/     跨进程契约(server / web / harness 共用)
tests/        Vitest,目录镜像被测代码
docs/         current(事实)/ adr(决策)/ plans(在建)/ archive(研究与施工记录)
```

## Server

```text
apps/server/src/
  deps.ts              基础设施装配:config / db / skills / observer
  services/index.ts    业务服务装配 → AppServices
  api/index.ts         组合根:route 可见的操作面 → AppApi
  routes/index.ts      挂载各模块的 route
  modules/<能力>/       垂直模块
  db/{schema.ts,migrations/}
  transports/sse/
```

Server 拥有 HTTP、SQLite、run 生命周期与能力装配；harness 拥有模型步与工具执行，
不 import server 代码。

- `app.ts` 拥有 Fastify 启动与关闭。`deps.ts` 造基础设施；`services/index.ts` 与
  `api/index.ts` 装配服务与 route 可见的操作。
- `RunCoordinator.run` 在异步准备之前、同一事务里接受输入并启动 run。一个会话一条主 run
  由准入与部分唯一索引双重保证。
- `requestId` 是可选 UUID，用于 HTTP 重试去重；重复请求返回已有 run 的身份与状态，
  不再追加输入。
- `AgentFactory.resolveModels({ modelId })` 解析请求的 chat 模型与可选 tool 模型
  （缺省/不可用时 tool 回落 chat）。`build` 装配 run agent；模型配置不来自环境变量。
  `LanguageModel` 实例有缓存；调用参数不进缓存 key。
- assistant 快照在执行期间按同一 message ID 更新；finish 时消息与终态一并提交，
  终态不会被二次结算覆盖。
- `tool_operations` 在执行前写 intent、执行后写 result，独立于可选观测。重启后未完成的
  操作标 `unknown`，绝不自动重放。`GET /api/v1/runs/:runId` 暴露 run 与 operation 回执。
- 关闭流程：停准入 → abort/drain 活跃 run → 关 MCP 与 SQLite；signal handler 有 deadline 兜底。

三条写代码时会被 `pnpm lint:arch` 拦住的硬规则：

1. **route 只能用 `app.api`。** 不许出现 `app.infra` / `app.services` / `db` / Repository /
   drizzle。想给 route 加查询 → 在对应模块的 `api.ts` 上加方法。
2. **跨模块只能从 `modules/<name>/index.ts` 进。** 模块内部文件默认私有。
3. **route 里不许 `new XxxRepository(`。**（模块内部自建 Repository 目前不受规则约束 ——
   那是 Wave 4 留下的存量债，见
   [ADR 0008](./docs/adr/0008-composition-root-only.md)。新写代码别再加。）

## Harness

- `createAgent` 创建 run-loop agent：一个 application loop 拥有 working messages，
  每次 `streamText` 执行一个 SDK step，续跑复用同一份 working history。
- `context-strategy.ts` 应用工具输出预算与自动上下文压缩。server 侧没有独立的
  「按消息数/token 自动 compact」策略；用户显式发起的会话压缩保持显式、分支感知。
- **所有工具（含 per-run 注入）走同一条管道**：plan policy → approval → concurrency →
  execution。重名在装配期即失败；缺 approval 回调时危险工具默认拒绝。取消不 detach 执行：
  loop 返回前先 drain 已派发的工具。
- **工具发现**：工具集大到挤占 prompt 时暴露核心工具 + `tool_search`。显式
  `activeToolNames` 永远优先。
- **Skill**：只暴露 `name` 与 `description`；`read_skill` 加载完整指令。没有 LLM skill
  选择、选择表或角色自动分配。
- **子代理是 awaited 工具**：隔离的 transcript、继承取消与审批处理；角色是静态列表。
  最终文本经 tool result 返回；没有后台启动、report 工具或 notice 注入。
- **Plan 模式**用 workspace plan 文件 + 用户 review。plan gate 只拦普通 write/edit 路径；
  它是护栏，不是沙箱。**Plan Weave 已移除。**
- `web_fetch` 返回分页 Markdown，不再二次调模型做摘要；SDK 工具校验错误不再由隐藏模型修复。

### 工具约定（`packages/harness/src/tools/<kebab-case>/`）

一个工具一个文件夹：

```text
tools/my-tool/
  tool.ts     createMyTool(config) 工厂 —— 用 buildTool() 返回 AgentTool
  client.ts   (需要时)provider 专用客户端
  types.ts    (需要时)局部类型
  index.ts    re-export
```

- `buildTool({ name, description, schema, execute, readOnly?, needsApproval? })`，
  Zod schema，`execute` 返回 `string`。MCP 工具用 `buildJsonSchemaTool`（JSON Schema 入参）——
  两者都用共享的 `TOOL_ERROR_PREFIX` 包错，好让 `stream-part-mapper` 一视同仁。
- 危险工具设 `needsApproval: true`，管道用 `withApproval` 包住它的 `execute`：
  审批闸门在 execute 期，一次模型调用即可，abort 能把 pending 审批收掉。
  审批归属 **runId**，不是 session。
- **`readOnly` 误标是有后果的**：只读工具会被并发帽放行，绕过串行意图（比如 plan 的 mutex）。

## SSE 契约

`POST /api/v1/runs/stream` 返回 SSE。事件名的唯一事实源是
`packages/shared/src/stream-events.ts`：

```text
run_start          第一帧:{ runId, sessionId }
text-delta         正文片段
reasoning-delta    推理片段
tool-input-start / tool-input-delta / tool-call / tool-result
step-start         新的模型步
finish             { text, toolCalls, finishReason, usage? }
approval_request / approval_resolved
plan_review_request / plan_review_resolved
subagent_update    子代理事件(信封带 taskId / parentToolCallId / description)
error
end                流结束(恒在 finish/error 之后)
```

每帧带 `seq`，在一次 run 内严格单调。`tool-result` 带三段计时
`toolExecMs / approvalWaitMs / queueWaitMs`（旧的 `durationMs` 不再赋值）。

## 前端（`apps/web/`）

Vite + React 19 SPA + Tailwind，feature-sliced：

```text
src/features/threads/     聊天页:hooks/(use-chat 组合 / use-run-controller 在飞 /
                          use-thread-messages 历史 / use-thread-list 侧栏)、
                          stream-reducer.ts(纯投影)、components/、trajectory/
src/features/settings/    真实路由 /settings/*(不是组件内 useState 切 tab)
src/features/workspaces/
src/shared/{api,ui,hooks,markdown,streaming}/
src/types/api.ts          从 @eva/shared 再导出
```

**三条不许动的渲染性能结论**（改之前先读注释）：

1. `use-chat` 的投影里 `committed` 与 `streaming` 是两个字段。一个 token 只换 `streaming`
   的引用，`committed` 数组引用整轮流式不变，memo 住的历史列表因此不重渲染。
   `tests/web/streaming/stream-reducer.test.ts` 逐帧 `toBe` 钉住了这条。
2. `useStickToBottom` 用 `scrollTop` 直写跟住底部（80px 内），**不是**
   `scrollIntoView({behavior:"smooth"})` —— 后者在逐 token 增长下会抖。平滑滚动只给「发送消息」这一刻。
3. `@tanstack/react-virtual` 在 40 条已完成消息以上才启用；在飞那条永远在虚拟化器之外。

审批走 SSE 的 `approval_request` / `approval_resolved`（**不轮询**）；`useApprovals` 挂载时调
一次 `listApprovals()` 把刷新前的 pending 捞回来。

会话：第一次请求不带 `sessionId` → server 建会话 → `run_start` 帧带回新的 `sessionId`；
之后带着它发。新会话把它清空。刷新后 `loadSession` 会问一次「这个会话有没有在飞的 run」，有就 attach。

## 各能力的关键约束

### 审批

- 归属键是 **`runId`，不是 sessionId**。
- `exit_plan_mode` 走**平行的 plan review 通道**（approve / revise / reject /
  reject_and_exit / dismissed，决策落 `approval_requests.decision`），前端渲染独立的
  `PlanReviewCard`（不是风险配色的审批卡），而且**永远不许有 always-allow key**。
- abort / 启动清扫时：普通工具 pending → `denied`，plan review pending → `dismissed`。

### Workspaces

一个本地目录绑到一个会话（`sessions.workspace_id`）。fs 工具按 run 从它注入；
目录下的 `CLAUDE.md` / `AGENTS.md` 注入系统提示（16 KB 上限）。路径必须过
`assertUsableWorkspacePath`（拒 `$HOME` 与 `/`）。工具输出溢出落
`~/.eva/tool-overflow/<workspaceId>/`，`read_file` 对它有只读白名单。

### MCP

DB 的 `mcp_servers` 是**运行时唯一事实源**，`~/.eva/mcp.json` 只在启动时导入 file-origin 条目。
工具名 `mcp__<server>__<tool>`，除服务器声明 `readOnlyHint` 外都要审批。
坏掉的 server 降级成 `state: "error"`，**永不让对话失败**。

### Memory

- 可搜索事实在 SQLite。`save_memory` / `search_memory` 是显式调用的工具，
  受 `settings.memory.enabled` 控制。
- `~/.eva/MEMORY.md` 与近期每日记忆文件是用户可编辑的，带上限注入。文件工具独立于
  DB 记忆开关，始终可用。
- `autoRetrieve` 在 run 前做本地确定性 FTS：跨源会话搜活跃 `global` + 当前 `workspace:<id>`
  事实，打包成有上界的 prompt 段，注入 ID 记进 `run_memory_refs`。不调查询改写模型，
  绝不回退成全量倾倒。
- `autoSummarize` 落地为 run 后事实提取（UI 叫「自动提取」）：run 成功在终态事务入队
  `memory_extraction_jobs`；入队错误只记日志，不失败已完成的响应。worker 存 run 的
  tool 模型 ID，执行时解析当前 provider 凭据，产出可 review 的 `memory_candidates`。
  review 模式绝不自动写；automatic 模式只落模型报告置信度 ≥ 85% 的候选。
  更新比对目标 revision，过期候选返回 HTTP 409 而非覆盖。
- 提取是单 worker、可中断、最多三次带持久退避重试；关闭流程停 claim、abort 活跃模型调用、
  把任务退回队列。禁用记忆/提取会取消未完成任务。已知辅助提取用量记进 `usage_records`
  （含 schema 非法响应）。
- 显式 DB 工具用同样的可见 scope。workspace 里的项目/决策保存保留该 workspace 与
  run/message 出处；别的工作区的 ID 不能经这些工具更新。
  检索预算含 prompt 标题与指引；两字符关键词走 scope 过滤的子串搜索
  （trigram FTS 匹配不到它们）。
- 源会话是出处不是可见性：删会话不删已接受的记忆；与该 run 绑定的待处理任务会被移除。
  自动提取绝不写 `MEMORY.md`。
- **没有** embedding provider、向量索引、后台 embedding 任务或隐藏查询改写。
- 历史规划文档描述的是已退役的设计；当前源码与本文以当前源码为准。

### Plan Gate（会话级审批闸门）

`enter_plan_mode` 建一行 `plans` + `<workspace>/.eva/plan-gate/<planId>/current.md`
（`.eva/.gitignore` 只在文件不存在时种下 `plan-gate/`）。run 级的 `PlanGateState` 喂
`withPlanGate`（最外层包裹：只硬挡对非 plan 路径的 `write`/`edit`；bash / memory / MCP
保持各自的审批语义）与每步的 plan reminder。**闸门状态是 execute 期 getter，不是 build 期快照** ——
否则「模型在 run 中途 enter」和「approve 后同 run 解除」都不成立。
写当前 plan 文件经同一个 `matchesPlanGatePath` 自动放行（`reason="plan-file"`）——
**不要绕过那个共享判断**。Plan Gate 是护栏，不是沙箱。

### 可观测性

「这个 Run 到底发生了什么」是一等事实，不靠 Pino 反推：

- **`run_events`** 是可选的 append-only 诊断记录（执行事实由 runs/messages/tool_operations
  保存）（`apps/server/src/db/schema.ts`，时间一律 epoch ms）。`seq` 由 **run-scoped recorder**
  独占单调分配（`modules/observability/run-recorder.ts`）：同一 Run 主 agent 与 awaited
  子代理共用一个实例（`UNIQUE(run_id, seq)` 成立的唯一理由）；子代理不创建独立 Run。
  `record` 绝不抛回 agent loop；payload 在 recorder 内定型（脱敏 → 截断 16 KiB → canonical JSON）。
  崩溃未闭合操作由启动清扫补 `operation_abandoned`，retention 按
  `observability.retentionDays` / `maxDatabaseBytes` 整 Run 粒度删
  （`usage_records` 独立存活 —— 0030 起它没有 runs FK）。
- **事件路径**：harness `AgentTelemetryEvent` → server `createObserverBridge(recorder).forAgent(agent)`
  （`agent: "main" | taskId`，**没有隐式 current run** —— runId 属于绑定不属于事件）→
  `fanout` 合并 Pino 第二订阅者。`AgentBuildOptions.observer` / `buildSubagent.observer` 必填。
- **三段计时**:`withApproval`（审批等待）/ `withConcurrencyCap`（排队等待）/ `withExecTiming`
  （真实执行）汇入 run-scoped `ToolTimingState`，mapper 在 tool-result 时取快照；
  SSE `tool-result` 帧带 `toolExecMs/approvalWaitMs/queueWaitMs`，旧 `durationMs` 不再赋值
  （历史消息徽章隐藏）。abort 补发落 `tool_call_abandoned`（`duration_ms` 未分解墙钟，不伪造三段）。
- **读取面**:`GET /threads/:id/trajectory`（会话 Run 事件，三元组游标）、
  `GET /runs/:id/trajectory`（seq 游标，两种语义不合并）、
  `GET /threads/:id/session-log`(JSONL 导出，byte 稳定）。**都不进 loopback token 白名单**
  （`loopback.ts` 精确相等判定，改前缀匹配前先想清在放行什么）。
- **轨迹页**:`apps/web/src/features/threads/trajectory/`（会话内「对话 / 轨迹」tab，聊天流不卸载）。
  `derive-trajectory.ts` 纯投影（展示行不落库）+ `display-list.ts` 折叠 + 虚拟化台账
  （prepend 按 totalSize 差值补 scrollTop)+ 三泳道 Overview + 类型化 Inspector
  （snapshot 顺 `refSeq` 取调用当时那份，不是当前定义）。

## 命令

```bash
pnpm build          # server + desktop 壳
pnpm serve:dev      # 只跑 server(tsx watch)
pnpm web:dev        # 只跑前端(Vite, 5173)
pnpm desktop:dev    # Electron 壳 + server + web
pnpm typecheck      # 全 workspace tsc
pnpm test           # vitest(全量)
pnpm lint:arch      # 架构边界(必须 0 error)
pnpm web:build      # 前端产物
pnpm desktop:build  # 桌面产物
pnpm desktop:pack   # 打包分发
```

> **Node ≥ 22**（`engines.node` + `.nvmrc` 钉住，CI 在 22 与 26 上都跑）。
> `AbortSignal.any` 只要 ≥ 20.3，但 `apps/server/tsup.config.ts` 按 `target: "node22"` 出码，
> 所以 22 是真实地板。桌面产物跑在 Electron 自带的 Node 上 —— 发版前在那儿验一次。
>
> **native 模块**：`better-sqlite3` 必须按当前 Node 的 ABI 编译。允许它跑编译脚本的开关是
> `pnpm-workspace.yaml` 的 `onlyBuiltDependencies`（**必须是 YAML 列表**；写成 `'["electron"]'`
> 这种字符串 pnpm 不认，编译会被静默跳过）。大面积报 `NODE_MODULE_VERSION` 不匹配时，
> 跑 `pnpm rebuild -r better-sqlite3` 复原。
>
> 除了升级 Node，**跑过 `desktop:build` / `desktop:pack` 也会触发它**：`rebuild:native` 把
> `.build/server-deploy` 里的 better-sqlite3 按 Electron ABI 重编，而 `pnpm deploy` 出来的副本
> 与 store 是硬链接 —— 仓库自己的那份于此一起变成 Electron ABI（实测：`pnpm test` 里 271 个
> 碰 DB 的用例全红，报 "compiled against ... NODE_MODULE_VERSION 133"）。**桌面构建之后要跑
> 测试，先 rebuild。**

**打包链**：`pack` = web build → server build → `pnpm deploy .build/server-deploy`
（server 的 prod node_modules，供 external 依赖）→ `electron-rebuild`（better-sqlite3 按
Electron ABI）→ electron-vite。产物 `Eva.app/Contents/Resources/{app.asar, server/dist,
server/node_modules, web/dist}`。
**deploy 输出落仓库根的 `.build/`，不落 `apps/desktop/`** —— 它带一份 server 的 `src/` 副本，
放在源码树里会被不认 gitignore 的 `grep -rn` 搜出来冒充源码。

**自更新**：electron-updater + GitHub Releases feed，mac 走 Squirrel ShipIt 整包换包。
**代码类组件（server / web / sidecar）一律随整包更新，不做组件级热更**；将来引入的重型数据
（模型权重、浏览器二进制）不进安装包，落 `~/.eva/` 运行时按需下载。发版前跑
`pnpm --filter @eva/desktop check:release`（四类产物 zip / zip.blockmap / dmg / latest-mac.yml，
漏 blockmap = 差量静默失效）。

## 配置

> **模型配置不走环境变量。** provider 与 API key 在 SQLite 的 `providers` 表
> （`~/.eva/eva.db`），从设置页管理，DB 是唯一事实源。环境变量只管进程级的事。
>
> **API key 静态加密**（AES-256-GCM，密文 `enc:v1:…`）。密钥在 `~/.eva/.secret-key`
> （0600，首次启动生成）—— **删了就永久解不开已存的 key**（要在设置页重新输入）。
> 惰性迁移：任何一次 key 更新（哪怕值没变）都会把那行加密；没碰过的旧行保持明文但继续可用。
> 密钥文件读不出来时 server 降级成明文存储并在启动时警告。

`.env.local`（仓库根，gitignored）：

| 变量 | 用途 |
|---|---|
| `PORT` | server 端口（默认 8082） |
| `HOST` | server 绑定地址（默认 127.0.0.1；`0.0.0.0` 会被拒 —— 那是暴露到局域网） |
| `LOG_LEVEL` | pino 级别（默认 info） |
| `DB_PATH` | SQLite 路径（默认 `~/.eva/eva.db`） |

工作区在应用内管理（不是环境变量）。MCP 配置文件 `~/.eva/mcp.json`。

## 写代码时

- **不要在注释里加任务编号**（`T44` / `S27` 这种）。注释要写「为什么这个顺序不能改」、
  「删掉这个约束会出什么故障」；编号留在 `docs/archive/plans/` 与 git 里
  （[ADR 0012](./docs/adr/0012-comments-explain-invariants.md)）。
- **加一份新状态**先在 [`data-ownership.md`](./docs/current/data-ownership.md) 里给它找所有者；
  找不到说明模块划分要先想清楚。
- **不要为「以后可能要换」造 Port**：门槛是「今天就有第二个实现，或跨 package」
  （[ADR 0006](./docs/adr/0006-ports-only-at-change-boundaries.md)）。需要限制调用方能力时，
  用同一实现的窄接口（`RunOpeningLedger` 那种），编译期生效、零新增工具。
- **测试放哪按被测代码的位置**，不按测试类型（[`tests/README.md`](./tests/README.md)）。
  数据库一律用真 SQLite（`initDb({ dbPath: ":memory:" })` + `migrateDb`），只有模型走假实现。
- 收尾前跑 `pnpm typecheck && pnpm test && pnpm lint:arch`；碰了前端再加 `pnpm web:build`。
