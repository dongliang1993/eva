# T4 · 清理与文档修订

> 前置：**T0–T3 全部完成并 commit**。
> 读之前先读 `00-overview.md` §1 执行契约。

这个任务的价值不在代码量，在于**让下一个人（或下一个模型）读到的文档不再骗他**。当前 `AGENTS.md` 里有四处会直接把实现者带沟里的错误描述（§4.1），它每天都在产生成本。

**分 4 个 commit**：

| commit | 步骤 | 内容 |
|---|---|---|
| 1 | Step 1 | 摘掉 `task` / subagent 半成品 |
| 2 | Step 2–3 | 删 work-mi 遗留部署物、死配置、T1–T3 残留 |
| 3 | Step 4 | 文档修订（AGENTS.md / README.md / docs 10,14,15） |
| 4 | Step 5 | FINDINGS 归档与分流 |

---

## 1. 先说清楚：这次「死代码清理」比预期的小

开工前我把常见嫌疑对象都 grep 过一遍，**下面这些都是活的，不要删**：

| 文件 | 状态 |
|---|---|
| `apps/server/src/agent.ts` | 活。`services/index.ts:3` 与 `routes/runs.ts:7` 都在用 |
| `apps/server/src/observability.ts` | 活。`deps.ts:11` → `createPinoObserver` |
| `packages/harness/src/agents/observer.ts` | 活。observer 事件流的类型定义 |
| `packages/harness/src/agents/coalesce-stream.ts` | 活。`lead-agent.ts` 在用（T2 之后仍在用） |
| `packages/harness/src/context/policy.ts` | 活。`lead-agent.ts:32` |
| `apps/server/src/services/run-registry.ts`（22 行） | 活。abort 链路 |
| `db/repositories/approval-repository.ts` | 活。`services/index.ts:20` |
| `db/repositories/session-compaction-repository.ts` | 活。compact 链路 |

**真正该删的只有三类**：半成品子代理（§Step 1）、work-mi 时代的内部部署残留（§Step 2）、T1–T3 换掉的旧实现残留（§Step 3）。

---

## 2. 涉及文件

### Step 1（删子代理）

| 文件 | 动作 |
|---|---|
| `packages/harness/src/subagents/{executor,registry,types,index}.ts` | 删 |
| `packages/harness/src/subagents/builtins/general-purpose.ts` | 删 |
| `packages/harness/src/tools/task/index.ts` | 删 |
| `packages/harness/src/prompts/sections/subagents.ts` | 删 |
| `packages/harness/src/index.ts` | 改：删 `:17` `:18` 两行 export |
| `packages/harness/src/agents/create-agent.ts` | 改：删 `:3-5` import 与 `:26-41` 装配块 |
| `packages/harness/src/agents/types.ts` | 改：删 `:10` import 与 `:59` `subagents?` 字段 |
| `apps/server/src/agent.ts` | 改：删 `:20` import 与 `:259` `subagents: [...]` |

### Step 2–3

| 文件 | 动作 |
|---|---|
| `apps/server/migration/` | 删整个目录 |
| `apps/server/src/config.ts` | 改：删 `INTERNAL_IM_SIGNING_SECRET` |
| （T1–T3 残留，见 Step 3 的 grep 清单） | 改/删 |

### Step 4–5

| 文件 | 动作 |
|---|---|
| `AGENTS.md` | 改：四处事实错误 + 前端目录 |
| `CLAUDE.md` | 不动（只是指向 AGENTS.md 的一行） |
| `README.md` | 改：LangChain 段落 + Roadmap |
| `docs/architecture/10-frontend-conventions.md` | 改：补 `renderer/` ↔ `apps/web` 映射 |
| `docs/architecture/14-eva-architecture.md` | 改：§4.4 / §5.3 / §5.5 / §6.1 / §7.2 状态标注 |
| `docs/architecture/15-eva-execution-playbook.md` | 改：S1.1 / S2 状态标注 |
| `docs/plans/README.md` | 新增：历史文档与在用文档的索引 |
| `docs/plans/r1/FINDINGS.md` | 改：分流并归档 |

---

## 3. 为什么把 14 §5.3 三级投递台账与 §5.5 late-arrival 窗口降级

`00-overview.md` §2.6 说了「本轮明确降级，理由见 T4 §3」——就是这一节。**这两节不删**（分析本身是对的，且以后会用上），但要加降级标注，避免有人照着实现一套用不上的机制。

### 3.1 三级台账（`accepted` / `started` / `claimed`）

WeaveLynx 需要它，是因为它的 agent 跑在**一个可能崩掉的 CLI 子进程**里，输入要在 buffer 里跨进程重启存活，所以「收到了」「送进去了」「被认领了」是三个真会分叉的时刻。

Eva 不是这个形态：输入走 HTTP POST 直达同一个进程，T1 之后 user message 落库与 `runs` 行创建**在同一个 handler、同一个同步段里完成**。也就是说 `accepted` 与 `started` 之间没有任何可以插入失败的窗口——两个打点永远同时翻。

`claimed` 唯一有意义的场景是**一个 run 在飞时又来了新输入**（steer / 中途插队）。Eva 现在没有 steer：`routes/runs.ts` 对同一 session 的并发请求没有插队语义，前端 `isStreaming` 期间输入框也是禁用的。没有 steer，「未认领的已 started 输入」的数量恒等于 0，`owedInput` 恒为 false。

结论：现在实现三级台账，等于加三列永远同步变化的状态 + 一个恒为 false 的派生量。**T1 的 `runs` 表（`status` + 终态原因）已经覆盖了当前形态下所有可观测的东西。**

**重新评估的触发条件**（写进 14 §5.3 的标注里）：实现 steer，或 agent 执行移出主进程（S7 子代理 worker / S6 扩展宿主）。任一发生，这一节立刻回到台面。

### 3.2 late-arrival 5s 窗口

WeaveLynx 的场景是：agent 在**另一个进程**，`tool_result` 经 IPC 回来时父进程已经 finalize 了这个 run，于是「磁盘上有副作用、DB 里没痕迹」。

Eva 的 agent loop 与 SSE writer 在**同一个 async generator** 里：`routes/runs.ts` 的 `for await` 消费完生成器才走 finalize。生成器返回之后，不存在还能投递 `tool-result` 的通道——没有 IPC，没有独立 worker。这个 bug 在当前形态下**结构上不可能发生**。

如果真出现「副作用落盘但 DB 无痕」，那它的成因是 finalize 路径上抛了异常，正确的解法是 `try/finally` + 在 `runs` 行上记终态（T1 Step 6 已经这么做了），而不是开一个 5s 的迟到窗口——后者只会把一个确定性 bug 变成一个偶发 bug。

**重新评估的触发条件**：agent 执行移出主进程。与 3.1 同一个触发点。

---

## 4. 步骤

### Step 1 · 摘掉 `task` / subagent 半成品

**为什么现在删而不是留着以后改**：`packages/harness/src/subagents/executor.ts` 有四个和目标架构（14 §4.5 fork-join 双原语）方向相反的问题，改它的成本高于重写：

1. **不透传 abort**：`:53` 的 `createAgent()` 没接父级 signal。用户点停止，父 agent 停了，子代理还在跑，还在写文件。
2. **`setTimeout` 不清理**：`:63-68` 的超时定时器在 `Promise.race` 胜出后没有 `clearTimeout`，每次子代理调用泄漏一个最长 5 分钟的活跃定时器。
3. **不流式**：用的是 `invoke()` 不是 `stream()`，UI 在最长 5 分钟里什么都收不到——没有进度、没有工具轨迹。14 §4.5 要求子代理有独立的可观测通道。
4. **不落库**：子代理的消息完全不进 DB，T1 打好的 `parent_id / slot_id / depth` 三件套一列都没用上。
5. **不透传审批**：`createAgent()` 没传 `requestApproval`，T0.4 之后子代理里的危险工具会被直接拒——即"能跑"也是残的。

**零测试覆盖**（`rg -ln "subagent|Subagent" tests/` 无结果），删除没有回归风险。

按 §2 的表逐个文件处理。`create-agent.ts` 删掉装配块后，`buildTools` 的返回就是纯工具列表，函数会短不少——顺手确认没有留下空的 if 分支。

删完跑 `pnpm typecheck && pnpm test`。

> **不要顺手实现新版子代理**。S7 会带着 fork-join 语义、独立流式通道、消息落库一起做。本步只做减法。

### Step 2 · 删 work-mi 遗留

**2a. `apps/server/migration/`**

```
apps/server/migration/config/values/biz-test.yaml
apps/server/migration/config/templates/config.json
```

这是 work-mi 时代内部发布平台的配置模板（`{{.biz.im.signingSecret}}` 这种 Go template 占位符）。Eva 是本地优先的桌面应用，没有这套发布流程。整个目录删。

**2b. `INTERNAL_IM_SIGNING_SECRET`**

`apps/server/src/config.ts:16`。全仓库除了 schema 声明本身，只有 2a 里那个模板文件引用它——即它从来没被读过。删掉这一行。

删完确认 `loadConfig` 的 schema 只剩：`PORT` / `HOST` / `LOG_LEVEL` / `TARGET_REPO_ROOT` / `DB_PATH`。这五个就是 Eva 全部的环境变量（Step 4 的文档要按这个写）。

### Step 3 · T1–T3 残留清扫

跑下面这组 grep，**每一条都应该无结果**；有结果就是前面的任务没扫干净：

```bash
# T1：旧消息模型
rg -n "MessageContentBlock|blocksToHistoryContent|parseStoredContent|DisplayMessage" apps packages --glob '!node_modules'
# T1：已删除的端点
rg -n "runs/wait" apps packages docs --glob '!node_modules'
# T2：手写循环的残骸
rg -n "appendStepMessages|splitInstructionsAndMessages|stringifyToolOutput" packages --glob '!node_modules'
# T3：旧前端
rg -n "agent-lab|scrollIntoView|types/api" apps/web/src
# 通用：四层相对路径 import
rg -n 'from "(\.\./){3,}' apps packages --glob '!node_modules'
```

另外检查两处**只在一个文件里用、却 export 了**的符号（`apps/web/src/shared/api/fetch.ts` 的 `ApiError` 在 T3 Step 7 已处理；这里复查 server 侧）：

```bash
# 列出 harness 的 barrel 导出，逐个确认有外部消费者
rg -n "^export \* from" packages/harness/src/index.ts
```

Step 1 删掉两行之后，`index.ts` 的每一条 `export *` 都应该有 `apps/server` 或 `tests/` 里的消费者。没有的，记进 FINDINGS，**不要在本步删**（barrel 是包的公共 API，删它要单独判断）。

### Step 4 · 文档修订

#### 4.1 `AGENTS.md`：四处事实错误

这四条不是"过时"，是**现在照着做就会做错**：

| 位置 | 现在写的 | 事实 |
|---|---|---|
| Project Overview | "a **LangChain-based** agent harness" | 早就不是了。harness 用的是 Vercel AI SDK v7（根 `package.json` `ai: ^7.0.64`），`@langchain/*` 一个都没装 |
| Tool Convention | "`apps/server/src/tools/`"，PascalCase 文件夹，`constants.ts` + `description.ts` + `index.ts` | **这个目录不存在**。工具在 `packages/harness/src/tools/<kebab-case>/`，文件是 `tool.ts` / `client.ts` / `types.ts` / `index.ts`，用 `buildTool()` 构造。整节要照真实结构重写 |
| SSE Streaming | `text_chunk` / `tool_call_start` / `tool_call_end` / `result` | 一个都对不上。真实事件名在 `packages/shared/src/stream-events.ts`：`run_start`、`text-delta`、`reasoning-delta`、`tool-input-start`、`tool-input-delta`、`tool-call`、`tool-result`、`step-start`、`finish`、`error`、`end`，外加 T0.4 的 `approval_request` / `approval_resolved` |
| Configuration 表 | `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_TEMPERATURE` / `WEB_FETCH_MODEL` | **这五个变量在代码里不存在**（`apps/server/src/config.ts:9-18` 的 schema 里没有，全仓库 `process.env` 也搜不到）。模型与 API key 走 `providers` 表 + 设置页，不走环境变量。真实的环境变量只有 Step 2 之后剩下的五个 |

配置那一节改写时要点明这个**设计事实**（不然下一个人还会去找 `.env`）：

> 模型配置不走环境变量。Provider 与 API key 存在 SQLite 的 `providers` 表里，通过设置页管理；`~/.eva/eva.db` 是唯一事实源。环境变量只管进程级的东西（端口、日志级别、DB 路径、工具的仓库根目录）。

同时要改的：

- **Commands 表**：`pnpm build` 的注释写的是 "Build the server (tsup)"，实际是 `--filter @eva/server --filter eva`（含桌面壳）。补上缺的 `serve:dev` / `typecheck` / `desktop:dev` / `desktop:build` / `desktop:pack`。
- **Frontend 一节**：`pages/ components/ hooks/ api/` 全部改成 T3 落地后的 `app/ features/ shared/`，并把 §Directory Structure 换成 T3 §4 Step 6 的目标树。
- **Architecture 一节**：`packages/harness/` 的描述补上 subagents 已移除（S7 再做）。

#### 4.2 `README.md`

`README.md:7` 的 Status 段落：

> "The agent harness currently uses **LangChain** (`@langchain/core` + `@langchain/openai`). The planned next step is migrating it to **Vercel AI SDK**..."

迁移已经完成。改成描述现状（AI SDK v7 + `@ai-sdk/anthropic` + OpenAI-compatible 适配），并把 Roadmap 里已完成项标掉。同时 `docs/architecture/` 那段写的是 "a 14-doc series (00–13)"，实际有 00–15 共 16 篇（缺 12），顺手改准。

#### 4.3 `docs/architecture/10-frontend-conventions.md`

在 §2 目录结构总览后面补一小节，写清 10 篇的三进程 `src/` 布局与本仓库 monorepo 布局的映射（内容直接用 T3 §2.4 的表）。**不要改 10 篇的约定本身**——约定是对的，只是它描述的是 Alma 的物理布局。

#### 4.4 `docs/architecture/14-eva-architecture.md`

逐节改状态标注（14 篇用 `【现状】/【目标】/【部分现状】` 这套标记，跟随它）：

| 节 | 改法 |
|---|---|
| §4.2 agent loop `streamText + stopWhen` | 【目标】→【现状，T2 已落地】 |
| §4.4 审批闸门【部分现状】 | 按 T0.4 实际实现重写：`withApproval` 高阶包装只套危险工具、审批走 SSE 事件、abort 时 `cancelBySession` 立刻拒。**并写明修复前的状态是"所有工具都跑不通"**——这是本轮最值得记下来的教训 |
| §4.5 子代理 fork-join | 补一句：现有半成品已在 T4 移除，S7 从零实现 |
| §5.3 三级投递台账 | 加【降级：S7 再评估】标注 + §3.1 的理由摘要 + 触发条件 |
| §5.5 late-arrival 窗口 | 加【降级：S7 再评估】标注 + §3.2 的理由摘要 + 触发条件 |
| §6.1 直接转发 AI SDK stream parts | 【目标】→【现状，T1/T2 已落地】 |
| §7.2 目标 schema | 与 T1 实际落地的 `messages` / `runs` 表对齐；差异的地方以**代码为准**改文档 |

#### 4.5 `docs/architecture/15-eva-execution-playbook.md`

S1.1（前端三红线）与 S2（UIMessage 整存）标为已完成，并在各自条目下链到 `docs/plans/r1/T1-uimessage-store.md` / `T3-frontend.md`。

#### 4.6 `docs/plans/README.md`（新增）

`docs/plans/` 现在混着历史设计与在用 spec，新人分不清哪份还算数：

```markdown
# docs/plans

## 在用
- `r1/` —— 当前一轮重构 spec（T0–T4）。入口：`r1/00-overview.md`

## 历史（保留作决策记录，不再更新，勿照此实现）
- `s1/s1-wrapup-technical-design.md` —— LangChain → AI SDK 迁移设计，已完成
- `2026-04-05-claude-code-style-compaction-design.md` —— 压缩策略设计，已实现于 `services/compact.ts`
- `s4-tools-approval.md` —— 审批闸门初版设计，**已被 r1/T0-p0-fixes.md §T0.4 取代**
```

### Step 5 · FINDINGS 分流

`docs/plans/r1/FINDINGS.md` 里积累的是 T0–T3 期间"发现了但按纪律没顺手改"的东西。逐条分三类：

1. **本轮能顺手修的**（一行改动、无行为风险）→ 在本任务的 commit 2 里修掉，条目标 `[done in T4]`；
2. **要单独做的** → 保留条目，补一句为什么值得做、粗估工作量，作为下一轮的输入；
3. **不做的** → 标 `[wontfix]` + 一句理由。

已知至少会有这几条（T3 Step 7 记的）：

- 审批接口是 `/api/tool-approvals`，其余是 `/api/v1/...` —— **归第 1 类**，本轮统一成 `/api/v1/tool-approvals`（前后端一起改，只有 `routes/approvals.ts` 和 `features/threads/api.ts` 两个文件）；
- `/settings/*` 子页靠组件内 `activeNav` state 切换而非路由 —— **归第 2 类**，直链 `/settings/providers` 定位不到 tab，要改成真子路由，但牵动 settings 三个大组件，单独做；
- 10 篇的 `renderer/` 映射 —— Step 4.3 已处理，标 `[done in T4]`。

FINDINGS 最后应该是一份**干净的、每条都有归属的**列表，而不是一堆待办。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test && pnpm web:build` 全绿
- [ ] `rg -n "subagent|Subagent|createTaskTool" apps packages --glob '!node_modules'` 无结果
- [ ] `ls apps/server/migration` 报不存在；`rg -n "INTERNAL_IM_SIGNING_SECRET" .` 只在 git 历史里
- [ ] Step 3 的五组 grep 全部无结果
- [ ] `rg -n "LangChain|langchain" AGENTS.md README.md` 无结果
- [ ] `rg -n "LLM_API_KEY|LLM_BASE_URL|LLM_MODEL|WEB_FETCH_MODEL|text_chunk|tool_call_start" AGENTS.md` 无结果
- [ ] `rg -n "apps/server/src/tools" AGENTS.md` 无结果
- [ ] AGENTS.md 里列的每一个环境变量，都能在 `apps/server/src/config.ts` 的 schema 里找到；反之亦然（**逐条对着念一遍**，这是本任务最核心的一条验收）
- [ ] AGENTS.md 里列的每一个 SSE 事件名，都能在 `packages/shared/src/stream-events.ts` 里找到；反之亦然
- [ ] AGENTS.md 的前端目录树与 `apps/web/src/` 实际结构一致（`tree -L 2 apps/web/src` 对照）
- [ ] `docs/architecture/14` 里所有 `【目标】` 标记都还名副其实（已落地的都改成了【现状】）
- [ ] `docs/plans/README.md` 存在，且 `docs/plans/` 下每个文件都在索引里
- [ ] `FINDINGS.md` 每条都有 `[done in T4]` / `[next]` / `[wontfix]` 三种标记之一

### 收尾自检

把 `AGENTS.md` 从头读一遍，问自己一个问题：**一个没读过这个仓库的模型，只看这份文档去改代码，会在哪一步撞墙？** 撞墙的地方就是还没改完的地方。
