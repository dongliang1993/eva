# R5 · 总览与执行契约

> 承接 `../r4/00-overview.md`。R1（T0–T4）、R2（T5–T10）、R3（T11–T14）、R4（T15–T16）已全部落地并 commit。
> 基线实证（`11048ff`）：`pnpm typecheck` 全绿；`pnpm test` 45 文件 / 354 项全绿。
>
> **本轮主题：追平 Alma（`docs/architecture/04-model-adapter-agent-harness.md`，下称 `docs 04`）对比出的六处差距 ——
> 两处是"会卡死/会整圈报废"的功能正确性，四处是生产级鲁棒性与成本治理。** WS 传输差异明确忽略。

---

## 0. R4 收口确认（代码实证）

| 项 | 实证 |
|---|---|
| 子代理 fork-join（T15） | `packages/harness/src/subagents/`（`subagent-tool.ts` / `run-subagent.ts` / `crew.ts`）+ `apps/server/src/services/subagents/subagent-runner.ts`（`runFork` 唯一 create+settle 边界）+ `background_tasks` 表（0021/0022 迁移）+ `messages.parent_tool_call_id` 隔离子树；`tests/subagent-{crew,tools,messages}.test.ts` |
| 记忆人类可读层（T16） | `apps/server/src/services/memory/memory-file-store.ts` + `memory-files-section.ts` + harness 三个文件工具；`apps/server/src/agent-factory.ts` 的 `MEMORY_PROMPT_SECTION` 写清五工具分工；`tests/memory-file-{store,section}.test.ts` |
| 主链未污染 | `buildActiveChain` 只认 `parentToolCallId === null`（`services/message-tree.ts`），T15 测试钉住 |
| 工程小修 | 审批卡片 SSE 推送、per-tool 白名单（T14 的 `classifyToolRisk` + `alwaysAllowTools`）已在 `routes/runs.ts` 的 `requestApproval` 里生效 |

---

## 1. 本轮要解决的问题

### 1.1 背景：与 Alma 的差距清单

R4 结束后做了一次 Eva ↔ Alma 全面对比（`docs 04` 全篇，WS 传输除外），14 项差异按"不追会出什么事"分桶。本轮只做用户圈定的六项：

| 编号（对比清单） | 差距 | 桶 |
|---|---|---|
| #2 | 审批矩阵缺 `isSubagent` 自动通过分支 | 必须追平（功能正确性） |
| #3 | 无 `repairToolCall`，schema 不匹配整圈报废 | 必须追平（功能正确性） |
| #1 | `providers.api_key` 明文落 DB | 生产级差距 |
| #11 | tool-overflow 无治理（无 LRU / 不脱敏 / 不洗 ANSI / Date.now 命名） | 生产级差距 |
| #10 | usage 塞在 `runs.usage` JSON 列，无法按天/按模型聚合 | 生产级差距 |
| #6 | `maxSteps = 25` 硬顶，长任务被砍 | 生产级差距 |

明确不追的（本轮范围外）：#4 steer_generation、#5 provider 特化、#7–9 SOUL/USER/HEARTBEAT/people 文件层（定位差异，T16 已做 Eva 版可读记忆）、#14 archived 标记（Eva 硬删已覆盖消息）。

### 1.2 #2：后台子代理调危险工具会挂到超时（🔴 已能复现的死法）

Alma 的审批是六分支决策树（`docs 04 §8.6.1`），其中分支 2：**`metadata.isSubagent === true` → 自动通过**。
理由是物理性的：子代理、cron、频道**没人能点弹窗**，不自动通过就永远卡住。

Eva 的现状把这条理由变成了现实：

```
subagent-runner.ts:160  buildSubagent({ role, ... })   ← 不传 requestApproval
agent-factory.ts:319    createAgent({ model, tools, ..., observer })  ← 无 requestApproval
create-agent.ts:11      requestApproval ? wrap : rest.tools           ← 不包
                        ↓
子代理的 write/edit/bash 是裸的 requiresApproval:true 工具,不弹审批(没人可弹)、也不拦截 —— 直接执行。
```

也就是说 Eva 现在的子代理**不是"卡住"，而是"无闸"**：能派出去的三个角色（explorer/researcher/reviewer）恰好都是只读白名单，问题没暴露；但 T15 §6 坑 5 早就写了"若将来给角色开写工具，必须同时给 per-path 互斥锁"—— 真到那天，写工具裸奔比一个会卡死的闸门更糟。

**目标形态**（与 Alma 矩阵同构，但落到 Eva 现有的 `requestApproval` 注入点上）：子代理也包 `withApproval`，但注入的 `RequestApproval` 第一个分支就是 `isSubagent → return true`。**自动通过进闸门、落 `approval_requests` 表（auto-approved）**，审批可追溯性（T14 建的那套）对子代理同样成立。

### 1.3 #3：schema 不匹配 = 一步报废 + 全额账单

`streamText` 收到模型返回的 tool call 后会做入参 schema 校验。Eva 没传 `repairToolCall`（`lead-agent.ts:236` 的 `streamText({...})` 参数表里查无此项），校验失败时 SDK 直接产出 `error` part —— **这一轮 tool call 报废，模型要再烧一整圈重试**；弱模型（DeepSeek、Kimi 旧版）经常漏 `path` 或把 `edits` 写成字符串，实测就是"同一步连炸三次然后放弃"。

Alma 的做法（`docs 04 §8.4`）：`repairToolCall: yg` —— 校验失败时把"错误 + schema"喂回模型修一次，修好就继续，修不好才报错。`ai` 包已暴露同名参数（`grep -c repairToolCall node_modules/ai/dist/index.d.ts` → 16，`ToolCallRepairFunction` 是正式导出，非 experimental）。

### 1.4 #1：apiKey 明文躺在 `~/.eva/eva.db` 里

`schema.ts:50`：`apiKey: text("api_key").notNull().default("")` —— 明文。`provider-repository.ts:166` 原样读出。
这台机器上任何能读 `~/.eva/` 的进程都能拿走全部 provider key。

Alma 用 Electron `safeStorage`（`docs 04 §8.3.2`：macOS Keychain / Windows DPAPI / Linux libsecret，不可用则降级明文）。**Eva 的 server 是 UtilityProcess，不直接持有 `safeStorage`** —— 这是本任务唯一需要决策的地方，三个选项：

| 方案 | 机制 | 代价 |
|---|---|---|
| **A. server 自管 AES-GCM** | key 存 `~/.eva/.secret-key`（0600），DB 里存 `enc:v1:<base64>` | 防"拷走 eva.db"，不防"拷走整个 ~/.eva"；无外部依赖，纯 server 可测 |
| B. Electron safeStorage 桥 | server → UtilityProcess 父进程 IPC 取密钥 | server 脱离 desktop 跑（`tsx apps/server`，开发/调试常态）时没有父进程，要再开一条降级路径 |
| C. 明文 + 文档明示 | 不改代码，`AGENTS.md` 写明"apiKey 明文，靠文件权限保护" | 零代码；但 key 泄露面不变 |

用户圈定原文是"apiKey 加密（或明文 + 文档明示）"。**本 spec 按 A 写**（B 的 IPC 桥在纯 server 开发路径上是倒退；C 是 A 做不完时的退路，T19 §2.4 留了"加密不可用时降级明文"的同款设计，降级形态 ≈ C + 显式标记）。

### 1.5 #11：tool-overflow 落盘文件永久堆积 + 可能带密钥

Eva 的 `tool-overflow.ts` 只有 30 行（`docs 04 §2.3` 说的是 Alma 版本，约 90 行）。逐项对比：

| 治理能力 | Alma（`docs 04 §8.6.2`） | Eva 现状 |
|---|---|---|
| 阈值 | 2000 字节 | 4000 字符 |
| 文件名 | `<Tool>-<field>-<sha1:12>.<ext>` 内容寻址，同内容不重写 | `${toolName}-${callId}-${Date.now()}.txt` **每次必写新文件** |
| 容量治理 | 200 文件 / 100MB，按 mtime LRU 清最旧 | **无 —— 永久堆积** |
| 脱敏 | `authorization: bearer/token` 值打码 | **无 —— `env` / `cat .env` 的输出原文落盘** |
| ANSI 清洗 | 终端颜色码剥掉再写 | **无 —— 落盘文件带 `\x1b[31m` 没法直接读** |
| 开关 | `ALMA_TOOL_OVERFLOW=0` 关闭 | 无 |

`bash` 跑 `env`、读取 `.env`、构建日志带 token —— 这些输出现在原样躺在 `~/.eva/tool-overflow/<ws>/` 里，而且永远不会被清。

### 1.6 #10：usage 查不出"这周烧了多少"

`runs.usage` 是 `StreamTokenUsage` 的 JSON TEXT 列（`schema.ts:192`）。`run-repository.ts:127` 的 `sumUsageBySession` 只能在**应用层循环 JSON.parse 再累加** —— 按天聚合、按模型聚合、prompt-cache 命中核算，全都做不到（SQL 进不了 JSON 内部）。

Alma 的 `usage_records` 独立表（`docs 04 §8.7.1`）：`date`（YYYY-MM-DD）列 + `input/output/cached_input/cache_write_input/reasoning/total` 六个 INTEGER 列，按天/按模型 GROUP BY 是一行 SQL 的事。prompt cache 两列（`cached_input_tokens` / `cache_write_input_tokens`）在 Anthropic 计费里差 10 倍价格，JSON 里就算存了也没法聚合。

### 1.7 #6：`maxSteps = 25` 是真实任务会撞到的硬顶

`agent-factory.ts:243`：`maxSteps: 25`。Alma 给 100（`docs 04 §8.4`："100 步 / steering 挂起 / AttemptCompletion 被调 三种停法"），实测 134 步分析会话可行（`docs 04 §2` 的实证案例）。

Eva 撞顶的表现不是报错，是 `lead-agent.ts:110` 那句 `"The agent reached the maximum tool-calling steps..."` —— 用户看到的就是"活干一半，agent 自己宣布不干了"。compact + tool-overflow 两道防线已经在管上下文，步数闸不该比上下文闸先响。

---

## 2. R5 范围与顺序

| 任务 | 文档 | 内容 | 估时 | 依赖 |
|---|---|---|---|---|
| **T17** | [`T17-subagent-approval.md`](./T17-subagent-approval.md) | 审批矩阵加 isSubagent 自动通过分支：子代理进闸门、自动放行、落审批记录 | 0.5–1 天 | — |
| **T18** | [`T18-repair-tool-call.md`](./T18-repair-tool-call.md) | `repairToolCall`：schema 不匹配时用 tool 槽位模型修一次入参 | 1 天 | — |
| **T19** | [`T19-apikey-encryption.md`](./T19-apikey-encryption.md) | apiKey AES-GCM 加密落 DB（方案 A），读路径透明解密，降级明文带标记 | 1 天 | — |
| **T20** | [`T20-tool-overflow-governance.md`](./T20-tool-overflow-governance.md) | tool-overflow 治理：sha1 内容寻址 + LRU（200 文件/100MB）+ 脱敏 + ANSI 清洗 | 1 天 | — |
| **T21** | [`T21-usage-records.md`](./T21-usage-records.md) | `usage_records` 独立表 + 写入路径 + `runs.usage` 双写过渡 | 1–1.5 天 | — |
| **T22** | [`T22-max-steps-100.md`](./T22-max-steps-100.md) | `maxSteps` 25 → 100（主/子代理同步），收尾文案与观测补齐 | 0.5 天 | — |

**顺序建议**：T17 最先（半天，且它是"子代理体系成立"的补丁，和 R4 收口同源）→ T18（独立）→ T20（独立，纯 harness）→ T19（独立，DB 读写的唯一改动点是 provider-repository）→ T21（有迁移，放后段）→ T22 最后（一行常量 + 文案，顺手收尾）。T17/T18/T20 三者无共同文件，可并行。

### 2.1 明确不做

1. **审批矩阵的其余四个分支**（cron / 频道 / 全局开关 / thread 绑定 channel）。Eva 没有 cron 与频道这两个概念，照搬是为一不存在的需求留分支。将来引入时照 `docs 04 §8.6.1` 补。
2. **steer_generation**（对比清单 #4）。需要 UI 配合（生成中输入框变 steering 框），是一整个 feature 而不是追平项。
3. **provider 特化**（#5：openrouter parallelToolCalls / kimi beta headers）。14 个 case 是 Alma 的生态位，Eva 的 provider-catalog 只有真实在用的几家，遇到具体模型不兼容再按个补。
4. **B 方案 safeStorage IPC 桥**（§1.4）。纯 server 开发路径（`pnpm dev:server`）上它是倒退；桌面端真要提升一档时，把 key 派生换成 IPC 取的是同一个 `Encryptor` 接口的实现替换，不推翻 T19 的读写路径。
5. **usage_records 的 UI**（用量页 / 图表）。T21 只把表与写入路径建好 + 给一个按天聚合的只读接口，UI 等有了数据再说。
6. **`runs.usage` 列删除**。T21 是双写过渡（新表为主、旧列保留），删列等下下轮 —— 双跑一段时间确认新表数据可信后再删。

---

## 3. 执行契约

**沿用 `../r1/00-overview.md` §1**（硬性流程、硬性边界、TypeScript 约束、代码风格、已知坑）+ `../r2/00-overview.md` §3 的四条（不用补丁修架构、命名要形象、删东西给 grep 实证、FINDINGS 只写 `../r1/FINDINGS.md`）+ `../r3/00-overview.md` §3 的两条（验收要在真实产物里验、读路径先改）+ `../r4/00-overview.md` §3 的两条（爆炸半径要有测试钉住、共享表不能污染主链）。开工前必读。

R5 追加两条：

1. **"自动通过"不等于"绕过闸门"。** T17 的全部价值在于子代理**进**闸门然后被放行 —— 审批记录落库、风险画像照算、`cancelByRun` 照常能取消。如果你发现自己在写"子代理不包 withApproval"的版本，那是把 R4 的裸奔状态合法化，不是追平 Alma。判定标准：子代理跑一次写操作后，`approval_requests` 表里有一行 `granted(auto)` 记录。

2. **凡是"脱敏/清洗/降级"类逻辑，测试里必须有"脏输入进、净输出出"的端到端断言。** 脱敏正则、ANSI 清洗、加密降级这三件事的共同点：写对了没感觉，写错了不报错（密钥照样落盘 / 文件照样没法读 / 明文照样进 DB），只能在测试里钉死。每个任务 §4 标了【测试先行】的步骤就是干这个的。

---

## 4. 关于 T19 方案选择的记录

§1.4 的 A/B/C 三选项，本 spec 选 A（server 自管 AES-GCM）。决策依据留在这一节，免得执行时重议：

- **B（safeStorage 桥）被否的原因**：Eva 的 server 有两条运行路径 —— 桌面端（UtilityProcess 子进程）与纯 server（`tsx apps/server/src/index.ts`，开发与调试的常态，`.vscode/launch.json` 的 "Debug Server" 就是这条）。B 在纯 server 路径上没有父进程可问，必须再开一条"降级自管密钥"的路径 —— 那就是 A，只是多了一层 IPC。
- **C（明文+文档）被否的原因**：用户的圈定里"加密"在前、"明文+文档"是括号里的退路。A 的成本就是一天，没有省这一天的理由。
- **A 的已知残余风险**（写进 T19 §6 坑）：key 与 DB 同在 `~/.eva/` 下，防的是"只拷走 eva.db"（备份、分享、误传）不防"整目录被端"。这在威胁模型上可接受 —— 整目录被端时 `~/.eva/mcp.json`、会话历史同样是明文，apiKey 不是最值钱的那条。

---

## 5. 验收总表

| 任务 | 一句话验收 |
|---|---|
| T17 | 子代理（explorer 拿临时写工具或新角色）执行危险工具 → `approval_requests` 表落一行自动 `granted` 记录、主界面**不弹**审批卡片、工具真的执行了；主线程危险工具照弹不误 |
| T18 | 模型返回缺 `path` 的 write 调用 → 修复器用 tool 槽位模型修一次 → 工具成功执行；修不好 → 报错进流（不是整圈悄悄报废） |
| T19 | 设置页存 apiKey → DB 里是 `enc:v1:` 前缀密文；重启后模型照常可用（读路径透明解密）；`~/.eva/.secret-key` 权限 0600；加密不可用时落明文但带 `plain:` 标记且日志告警 |
| T20 | `bash env` 输出落盘的文件里 `authorization`/`token` 值已打码、无 ANSI 码；同一内容两次 overflow 只写一个文件；手工塞 201 个文件进 overflow 目录后再触发一次 → 最旧的被清到 200 |
| T21 | 跑一轮对话 → `usage_records` 表多一行（date/model/六个 token 列齐全）；`sumUsageBySession` 改走新表后结果与旧 JSON 路径一致；按天 GROUP BY 一条 SQL 能出数 |
| T22 | 构造一个需要 30+ 步的任务（或调低阈值实测）→ agent 跑到完成而不是 25 步被砍；`max-steps` 收尾时文案告知"可以追问继续" |
