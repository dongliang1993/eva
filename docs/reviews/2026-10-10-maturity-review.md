# Eva 成熟度评审：距离"成熟的 agent 项目"还差什么

日期：2026-10-10。代码基线：`0b38b29`（`feat(mcp): mcp.json 成为唯一事实源,设置页 UI 按新设计重写`）。
评审范围：`apps/`、`packages/`、`tests/`、`scripts/`、`docs/`，以及 `.refrences/` 里七个参考项目的对照。

## 0. 本轮做了什么、没做什么

**做了：**
- 跑通全部验证闸门：`pnpm lint:arch`（8 条规则，0 error / 0 warning）、`vitest run`（**88 文件 / 689 用例全绿**，12.6s）。
- 逐文件读执行内核（`packages/harness`）、server 主链（`modules/runs` 五个文件）、上下文与记忆子系统、工具管道、审批链、桌面启动序列。
- 对三个结论做了**动态验证**（不是静态阅读）：`applyToolResultBudget` 的并行结果缺陷、`isSafeReadOnlyCommand` 的放行面、两个 token 估算器的口径差。复现方式写在对应条目里。
- 对照 `.refrences/` 里七个参考项目（alma / cc / cindy / deepseek-harness / kimi-code / multica / weave + sentry-mcp）做能力对照。

**没做（因此下列结论有边界）：**
- 没打真实付费模型、没做长时 soak、没做 OS 强杀恢复实验、没跑打包产物。
- 没有做 agent 质量评测 —— 这既是本轮的结论之一，也是本轮的局限。
- `.refrences/alma` 与 `.refrences/weave` 的主进程是压缩产物，只能做字符串层对照，相关结论标注为弱证据。
- 安全小节只写**漏洞类别**与判定路径，不写成可直接执行的验证串 —— 本仓是用户本机运行的 agent，文档里留可复制的绕过串本身就是风险。

**与既有评审的关系：** `docs/reviews/2026-09-05-server-harness-production-review.md` 修的是**执行语义**（原子性、幂等终态、上下文归属、并发写）。那份的六项缺陷已在 `2026-09-05-refactor-progress.md` 里逐条落地。本轮不复述它们，只标注哪几条**仍未闭环**。本轮的焦点是那份评审没有覆盖的一层：**能力面**（评测、沙箱、可靠性预算、领域层）。

---

## 1. 结论

**工程架构上，这个项目已经越过了"学习项目"的水位线。** 依赖方向由脚本强制、主链可在五个文件内读完、终态只有一个出口且由编译器把守、文档按"事实/决策/在建/考古"四分。这些不是标语，是能被 `lint:arch` 和 `tsc` 判定的东西。

**能力面上它缺一层，而这一层恰好是"成熟 agent 项目"的定义项：评测。** 一个 agent 项目可以没有沙箱（不好），但不能没有评测（不可知）—— 没有评测，后续所有改动都无法判断是变好还是变坏，架构再干净也只是"整洁的猜测"。

**如果"学习 agent"指的是面向用户的学习产品，那领域层目前是零。** 见 §6。

---

## 2. 已经站稳的部分

列出来不是为了肯定，是为了在 §3 的删改建议里划出**不要动**的边界。

| 能力 | 证据 |
|---|---|
| **文档四层分工** | `docs/current`（今天的事实）/ `adr`（为什么）/ `plans`（在建）/ `archive`（考古）。`docs/README.md` 与 `AGENTS.md` 都明文规定冲突时以 `current` 为准并一起改 |
| **终态只写一次** | ~~`RunOpeningLedger` / `RunSettlingLedger` 让"在 coordinator 里结算终态"编译不过~~ —— **更正（2026-10-12）**：评审时照着文档写的，未对照代码；窄接口与 `RunFinalizer` 当时已不存在。实际的保证是 `runs.settle` 的条件更新（只改 `status = 'running'` 的行），收尾路径已收成 `Coordinator.settle()` 一个出口 |
| **可判定边界被自动化守** | `scripts/check-architecture.mjs`；route 只能拿 `app.api`，拿不到 `db` / Repository |
| **测试策略正确** | 真 SQLite + 真迁移（39 个文件），只假模型（`MockLanguageModelV4`，114 处引用）。`tests/README.md` 明确解释了为什么不用假 DB |
| **自己给自己做手术** | `2026-09-05` 那份评审是真做了的：六项缺陷每项给了动态复现，`refactor-progress.md` 逐条记了修法 |
| **运行语义有理由** | 工具管道 `plan gate → approval → concurrency → exec timing` 的顺序、SSE 断连不等于停止、`seq` 由 run-scoped recorder 独占、审批归属键是 `runId` 而非 `sessionId` —— 每条都写了"换了会怎么坏" |
| **诚实** | Plan Gate 明写"是护栏，不是沙箱"；`usage/route.ts` 明写砍掉了成本计价；`architecture.md` 把 Wave 4 遗留的 17 处 `new Repository` 作为债列出来而不是藏起来。**这个品质在后面几节里很关键 —— 它意味着补缺时不会自欺** |

`git log` 共 163 个提交，首提交 2026-04-08。从 6 个月的工作量看，代码 33.3k 行 / 测试 15.2k 行（比例 0.45）是健康的。

---

## 3. 缺口清单（按严重度）

### 3.1 P0 — 没有评测，这是唯一的"不可知"级缺口

**现状：** `git ls-files | grep -iE "eval|golden|judge"` → **零命中**。全仓唯一的 bench 是 `apps/server/scripts/run-events-bench.ts`，测的是 `run_events` 的同步写延迟，与 agent 质量无关，且不进 CI。

`docs/plans/README.md` 当前写"没有在建的轮次"，`refactor-progress.md` 的 *Remaining release validation* 五条里有三条属于这一类（真实 provider 的 agent 质量任务集、记忆提取精度、外部 MCP 副作用）。

**为什么这是 P0 而不是 P2：**
1. 你自己的评审已给出判据（`production-review.md` 末段）："只看 typecheck 和 mock 单测数量不能判断 agent 质量"。这句话是对的，而当前状态正好落在它批评的那一侧。
2. 689 个用例全是 mock 模型下的**契约测试**。它们能证明"结构对了"，不能证明"agent 干得对"。被测的是编排，不是能力。
3. 没有它，§3.2–§3.6 的每一项改动都只能靠手感判断收益。**它是其他所有优化的度量仪。**

**参考实现的三种成熟做法（都在本机 `.refrences/` 里）：**

| 做法 | 位置 | 特点 |
|---|---|---|
| record / replay 快照 | `deepseek-harness/packages/test-support/{llm-replay,llm-mock-server,agent-loop-testkit}` + `vitest.snapshot.config.ts` | `record` 打真 API 收流存盘；`replay` 默认无 API key 起真子进程，把组装的请求与 transcript 跟 golden **逐字节 diff**。配套一个能造断开 / 半流的故障注入 mock server |
| LLM-as-judge | `sentry-mcp/packages/mcp-server-evals/src/evals/utils/{runner,toolPredictionScorer}.ts` | 用 `generateObject` 比对"预测的工具调用 + 参数"与期望；上游 API 用 MSW mock |
| VCR | `cc/services/vcr.ts`（`withVCR` / `withStreamingVCR`） | 录制回放 API 响应（含流式与 token 计数），另有 mock 限流 |

**建议的形态（不必照搬全套）：** 15–20 个固定任务 + record/replay + 一个故障注入 mock。任务集要覆盖 `production-review.md` 自己列的那几类：跨步骤保留约束、读取后修改、被拒操作不换工具重试、长上下文保留原目标、工具超时后的收尾、跨分支重试隔离。指标至少含：成功率、错误副作用数、首 token 时间、总耗时、全部模型调用的成本。

---

### 3.2 P0 — bash 无任何沙箱，且免审批判定有系统性漏洞

**现状：** `packages/harness/src/tools/fs/bash-tool.ts` 用 `spawn("/bin/bash", ["-lc", command], ...)` 起**真登录 shell**：能读、能写、能联网，工作区之外畅通，`env: process.env` 把父进程整个环境交给它。

启动链上这不是小事：`apps/desktop/electron/shell-env.ts` 用 `execFileSync(shell, ["-ilc","env"])` 捞**用户登录 shell 的完整环境**，`server-supervisor.ts` 合并进 server 进程。也就是说 bash 拿到的是用户本机环境 —— 包含 server 自己的 loopback token，以及用户 `.zshrc` 里可能存在的任何凭据。输出只在落 overflow 文件时做脱敏（`tool-overflow.ts` 的 `redactSecrets`），正常尺寸的输出原样进模型。

**免审批判定（`tools/safe-readonly.ts`）** 是"直放"开关：命中白名单且无写/执行形态 → 不弹审批直接执行。它的实现是"先枚举坏形态、再白名单准入"，而坏形态是**正则枚举**。把该函数单独抽出验证（`node --experimental-strip-types`，只读，不落盘），下列**类别**全部被判为可直放：

- **命令分隔**：只拦了 `&&` / `||` / `;`。换行与单个 `&` 不算分隔符 → 白名单命令后可以接第二条命令。
- **替换与进程替换**：只拦了反引号与 `$(`。进程替换形态不在排除集。
- **管道**：只黑名单了 4 个名字（`tee` / `sh` / `bash` / `zsh` / `xargs`）。管道进**其他任何解释器**、或进任何能外发数据的网络工具，都仍算只读。
- **`find`**：只拦了两个 flag。同类能产生副作用的 flag 还有别的。
- **`git` 子命令**：白名单了三个子命令，但**不限制它们的参数** → 写文件类的 flag 能过。
- **路径**：完全不检查。白名单命令读工作区外的任意文件（例如用户私钥）算直放。

`tests/harness/tools/safe-readonly.test.ts` 对以上**一条都没覆盖**。

**同类对照：**
- `deepseek-harness`：真正的 `SandboxMode` 缝（read-only / workspace-write / danger-full-access），后端有 Linux bubblewrap + Landlock、macOS Seatbelt、Windows ACL 受限令牌，还有一个 fail-closed 的静态 Landlock 启动器。**并且如实上报 enforcement 是 `full` 还是 `partial`**（`docs/subsystems/sandbox.md`）。网络出口明确排除在沙箱范围外 —— 也就是它没有假装覆盖。
- `cc`：包 `@anthropic-ai/sandbox-runtime`（Seatbelt / bwrap），有文件读写限制配置，**并且有网络出口 allow/deny list**（`cc/utils/sandbox/sandbox-adapter.ts`），配套约 24 个文件的规则引擎（模式、规则解析、路径校验、危险模式表、bash 分类器、拒绝追踪、遮蔽规则检测、bypass 模式的 kill switch）。

**修法方向（分两步，都不必一次做到底）：**

*第一步（低成本，先做）：*
- `env` 收窄成显式白名单，不再传整个 `process.env`。
- 免审批判定从"枚举坏形态"改成**先解析命令结构再判定** —— 需要真正的 shell 词法分析（或至少一个能识别分隔符/替换/引号状态的解析器），而不是在字符串上叠正则。当前实现会漏放是**结构性的**，补正则是补不完的。
- fs 工具的路径包含性检查补 `realpath` —— 现在 `resolve-workspace-path.ts` 只做字符串 `path.relative`，符号链接不被解析，工作区内指向外部的链接能过。注意 `atomic-write.ts` 会**保留链接**并写向链接目标，这条路径同样要覆盖。

*第二步（结构性）：*
- 引入 SandboxMode 缝，macOS 走 Seatbelt。**关键是要如实上报 enforcement 等级**，不要在上报 `partial` 的时候让 UI 看起来像 `full`。
- 网络出口策略（`cc` 的做法可抄）。

> **不要动的一条：** 现在文档明说"Plan Gate 是护栏，不是沙箱"。这个诚实必须保持。修完之后再说它是什么。

---

### 3.3 P1 — 模型调用层没有自己的重试与超时

**现状：**
- `packages/harness/src/models/errors.ts` 计算了 `NormalizedModelError.retryable`（`prompt_too_long` / `context_window_exceeded` / `max_output_tokens` / `rate_limit` 都标 `true`），但**全仓没有一个读者** —— `errors.ts` 之外没有任何地方读这个字段。也就是说 429 唯一的活路是 AI SDK 默认的 2 次重试（`maxRetries = 2`，2s 起步，因子 2），重试耗尽就以 `failureLayer: "model"` 结束整轮。
- **没有首 token / 单步 / 总时长超时。** `packages/harness/src/agents/types.ts` 的 `toolTimeout` 注释明写"`totalMs/stepMs/chunkMs` 明确不做"。AI SDK 支持这三项。**后果：挂死的模型流只能靠用户手动 abort。** 对一个"本地优先桌面助手"，这是用户能直接感知的故障模式。
- 没有 provider 级 failover。`agent-factory.ts` 里"tool 槽缺省回落 chat"是**配置回落**，不是运行时切换。
- 记忆提取路径显式设了 `maxRetries: 0`（`memory-automation.ts:334`），是全仓唯一显式设置重试的地方 —— 讽刺的是它是关掉重试。

**同类对照：**
- `cc/services/api/withRetry.ts`：10 次重试、500ms 起步、尊重 `retry-after`、**529 过载单独封顶 3 次**、持久重试模式、fast-mode 冷却；`FallbackTriggeredError` 切到 `fallbackModel`。
- `deepseek-harness/packages/llm/llm-retry/`：对 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT` 五类各 5 次、500ms→10s 带 jitter、尊重 provider `retry-after`，无人值守模式有 "always"；**每次重试是一条持久事件、开一个新 turn**（可回放）。
- `kimi-code/packages/agent-core/src/loop/retry.ts`：10 次、0.5s→32s、25% jitter、带 trace id；另有模型目录级 failover 与工具调用去重。

**建议顺序：** 先补**首 token 超时**（对挂死流是唯一解，且改动面最小）→ 再接 `retryable` 标记做一个有上限的退避重试（含 jitter 与 `retry-after`）→ 最后才考虑 failover。

---

### 3.4 P1 — 从不请求 prompt cache

**现状：** `run-loop.ts` 里 `streamText` 的实参已逐项读过：`model` / `messages` / `tools` / `activeTools` / `stopWhen` / `prepareStep` / `abortSignal` / `timeout` / `temperature` / `maxOutputTokens` / `onStepStart` / `onError`。**没有 `providerOptions`。** 全仓 `cache_control` / `cacheControl` 零命中。

cache token 是**被动读**的：`observer.ts` 从 provider 上报的 usage 里取 `cacheReadTokens` / `cacheWriteTokens` 并落库（`cached_input_tokens` / `cache_write_input_tokens`，迁移 0023 / 0025），有测试钉住（`tests/harness/context/usage-cache-tokens.test.ts`）。**读取链路是通的，只是从来不主动请求。**

对一个 system prompt 与工具 schema 稳定不变、且**每一步都重发整份历史**的桌面 agent，这是白送的成本与首 token 延迟。注意 `prepareStep` 每步把 system 消息上提到 `instructions`（`context-strategy.ts`）—— 上提位置是否稳定，直接决定 cache 命中率，做这件事时要一起看。

---

### 3.5 P1 — token 估算全是启发式，且两个估算器口径不一致

**现状：**
- **harness**（决定要不要压缩）：`Math.ceil(text.length / 4)`，不分语种。见 `context/runtime-compact.ts:13` 与 `context/tool-result-budget.ts:10`。
- **server**（算 UI 用量条 / compact / 记忆打包）：CJK 字符（`charCodeAt(0) > 0x2e80`）算 0.5 token，非 CJK 算 0.25，外加每消息 4 token 开销。见 `lib/token-estimator.ts`。
- 全仓**没有任何 tokenizer 包**（无 tiktoken 等）。
- 判定溢出时若有上一步真实 `usage.inputTokens` 就用真值，否则退回估算 —— 这个设计是对的（`isOverflowing`）。

**后果（对中文场景更明显）：** 中文大约 1 token/字，`length/4` 会低估 3–4 倍。也就是说**中文长会话里 proactive compact 该响的时候不响**，一路撑到 provider 报错，然后靠 reactive compact 那条**每个 run 只允许用一次**的兜底接住（`hasCompactedReactively`）。第二次溢出就没有第二次机会了。

另有一处口径缺陷：harness 的估算**只算 message 文本**，没有计入 system prompt、会话摘要（已被移到 instructions）和工具 schema —— 而这三项在带 MCP 的会话里都不是小数目。

**同类对照：** `kimi-code` 在窗口 85% 触发 full compaction、保留 50k 输出、允许最多 3 次溢出恢复；`cc` 有 13k buffer 与 warning/error 双阈值，且有 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 的熔断（连续 3 次压缩失败就停手）。两个都在"压缩失败怎么办"上有明确答案，Eva 目前没有。

**修法：** 接真 tokenizer（或至少按脚本类型分 CJK/Latin 段估算）、统一两个估算器到一处、把 system prompt 与工具 schema 计入。

---

### 3.6 P1 — 上下文管理里有两个缺陷，且都没有测试

#### (a) 并行工具结果的裁剪会破坏 tool-call / tool-result 配对 —— **已动态复现**

AI SDK 把**一步内并行的多个 tool-result 收进同一条 `role: "tool"` 消息**（`ai@7.0.64` 的 `toResponseMessages` 里 `toolResultContent.length > 0` 才 push 一条 `role: "tool"`）。而 `applyToolResultBudget` 的读取函数 `readToolResultPart` **只取该消息的第一个 tool-result part**（`tool-result-budget.ts:63-69`），随后重建消息时把**每一个** tool-result part 都替换成用第一个 part 造的 stub。

用三个并行 `tool-call`（`call_A` / `call_B` / `call_C`）构造一条 `role: "tool"` 消息、给一个小于其总量的预算，实测替换后：

```
原文应为 : call_A, call_B, call_C
实际变成 : call_A, call_A, call_A
B/C 丢失 : 是
```

三个 part 的 `toolCallId` 全部变成 `call_A`，`call_B` / `call_C` 的结果丢失。附带地，token 估算也只算了第一个（候选是按消息去重、按第一个 part 计价）。

**触发条件：** 一步内并行 ≥2 个工具调用，且它们的合计输出超过 tool-result 预算。Eva 的只读工具并发帽默认 10（`DEFAULT_READ_ONLY_CONCURRENCY`），并行是常态 —— 例如一次读三个文件。这条在带大文件的会话里会真的发生。

**测试覆盖：** 无。`tests/harness/context/` 下三个文件没有一条测并行结果。

#### (b) 压缩的尾部切分不检查配对

`compactRuntimeMessages` 用 `runtimeMessages.slice(-preservedRecentRuntimeMessages)` 切保留尾部（`runtime-compact.ts`）—— **纯计数，不做配对检查**。如果尾部起点正好落在一条 `role: "tool"` 消息上，而它的 assistant `tool-call` 已被折进摘要，就产出一条孤立的 tool 消息。

服务端侧的 `convertToModelMessages(..., { ignoreIncompleteToolCalls: true })`（`run-preparation.ts`）**只管反方向**（有 call 无 result），帮不上这个场景。

**可构造的序列：** 上一轮在工具步达到 maxSteps 结束 → 历史尾部是 `…A(tool-call), T, A(tool-call), T` → 新用户消息 `U` 进来 → 保留 4 条得到 `[T, A, T, U]`，尾部以孤立 `T` 开头。

**测试覆盖：** 无。

> 这两条都属于"结构上正确、边界上不对"的类型 —— 和 §3.2 的只读判定同源：**判定依赖字符串/计数的枚举，而不是结构不变量。** 修的时候值得一起想。

---

### 3.7 P1 — 没有 E2E、没有真 provider 测试、没有组件测试、覆盖率未知

| 维度 | 现状 |
|---|---|
| E2E（真跑 app） | **无**。`package.json` 与 `pnpm-lock.yaml` 里没有 Playwright / Spectron / WebdriverIO / Electron 测试 runner。`tests/desktop/updater-download.test.ts` 是更新下载器的单元测试，不是 E2E |
| 真 provider | **无**。没有任何测试构造 `createAnthropic` / `createOpenAICompatible` 或读 `*_API_KEY`；`provider-routes.test.ts` 与 `web-fetch.test.ts` 都是 stub 掉 `globalThis.fetch` |
| 前端渲染 | **无**。4 个 web 测试全是纯逻辑（`stream-reducer` / `accumulator` / `derive-trajectory` / `display-list`）。没装 jsdom / happy-dom / testing-library。`apps/web/src` 有 95 个 ts/tsx 文件，**一个组件都没渲染过** |
| 覆盖率 | **未知**。`vitest.config.ts` 无 `coverage` 块，没装 `@vitest/coverage-v8` / istanbul / c8 / nyc，CI 也没有覆盖步骤 |
| 性能/负载 | 无（`run-events-bench.ts` 是唯一 bench，手动跑，不进 CI） |
| CI | ubuntu × Node {22, 26}，跑 `lint:arch` / `typecheck` / `vitest` / server build / web build。**不含 Electron 构建、不含打包、不含 macOS job** |

CI 矩阵本身是个好设计（注释里写了为什么：本机 Node 升到 v26 后 269 个用例静默全红而无人发现）。但**桌面壳的构建与打包完全没进 CI**，而 `AGENTS.md` 自己警告过 `desktop:build` 会把仓库里的 better-sqlite3 重编成 Electron ABI、导致后续测试全红 —— 这类事故 CI 是能抓的，现在抓不到。

**优先级低于 §3.1：** 覆盖率数字本身对 agent 质量贡献有限（689 个 mock 契约测试的覆盖率再高也不说明 agent 干得对）。**建议先做 §3.1，再回头补覆盖率**，否则容易把精力花在数字上。

---

### 3.8 P2 — 文档已经漂移，且违反你自己定的规矩

`docs/current/*.md` 三份都标注"最后一次逐项对照代码：2026-08-31"。此后 12 个提交（含 `mcp.json` 成为唯一事实源这类结构性改动）。逐项核对结果：

| 文档说 | 实测 |
|---|---|
| `architecture.md:64` "17 个模块"，表格列 `plan-weave` | 实际 **16 个**；`plan-weave` 在代码里**零命中**（已退役） |
| `data-ownership.md:43` Plan Weave 是文件事实源（`<workspace>/.eva/plan-weave/`） | 同上，不存在了 |
| `data-ownership.md:14,28` `memory_embeddings` 虚表、`modules/memory/memory-recall.ts` | **都不存在**（0031 迁移已删 embeddings；`memory-recall.ts` 无此文件） |
| `architecture.md:180` "9 条规则" | 实际 **8 条** |
| `architecture.md:182` "96 文件 / 761 用例" | 实际 **88 文件 / 689 用例** |
| `tests/README.md` "（当前 761 个）" | 同上 |
| `architecture.md:75` compact 模块做步中 auto-compact | 步中压缩**只在 harness**，server 侧只有显式 compress |
| `AGENTS.md:95` "Plan Weave 已移除" | ✅ 正确 —— 但 `architecture.md` 没跟着改 |

最后一行是问题的核心：**规矩是"不允许两份各自演化"，现在正是那个状态** —— 同一个模块一处说活、一处说死。这类漂移会自我强化：下一个读 `architecture.md` 的人会去找 `plan-weave` 模块，找不到，然后开始不信任文档。

**同时还有一批"接了一半的线"**（都实测确认过）：

| 项 | 状态 |
|---|---|
| `blockingBufferTokens` | 定义了、解析了，**从没被读过**（只在 `policy.ts` 内出现） |
| `isMaxOutputContinuationCandidate` | 定义了，**零调用者** |
| `MAX_SUMMARY_ITEMS = 8` | 定义了，**从没被用过** |
| `memories.status = "superseded"` | 枚举有，**没人写** |
| 候选的 `ignore` action | 契约有、DB 有，提取 schema **永远产不出** |
| `createMemoryPromptSection` | harness 导出一个，**没人用**；server 有个同名不同签名的 |
| `read_memory_file` 参数 | 描述里写 `file`，实际参数名是 `from` |
| 删除记忆的工具 | **不存在**（`listAll` / `deleteById` 实现了但没工具用） |
| 会话级 compact 的 route | 有 `POST /threads/:id/compact`，**前端零调用** → 实际是死代码；`trigger:"auto"` 也无任何路径触发 |
| `memories.metadata` | 恒为 `{}` |

这些单条都不致命，但合起来是**信号**：它们说明有些能力是"按计划表做完了"而不是"按需求做完了"。§3.1 的评测能防住这类漂移 —— 有任务集在跑，"半接的线"会变成红。

---

### 3.9 P2 — 可观测性出不了本机

**现状：** 无 OpenTelemetry、无 Sentry、无 Electron `crashReporter`、无 `uncaughtException` / `unhandledRejection` handler（`app-lifecycle.ts` 里只有生命周期钩子）。Fastify 的 `setErrorHandler` 只把 `ZodError` 转成 400。

**本地这套其实做得很好：** `run_events` append-only 台账、三级 capture level（`off` / `redacted` / `full`）、写前脱敏、16 KiB 截断 + hash、按整 Run 粒度的 retention（30 天 / 1 GiB）、启动清扫补 `abandoned`、两种游标语义的 trajectory API、byte 稳定的 JSONL 导出。**问题纯粹是"出不去"** —— 用户那边崩了，你没有任何通道知道。

对照：`cc` 有完整的 OTel span 树（一个 interaction span 套 LLM-request 与 tool span）+ Perfetto 追踪 + Datadog/BigQuery 导出 + `/cost`；`cindy` 的日志上传有**三态 consent gate**、脱敏、来源白名单与崩溃触发（这个设计比"默认开启"更值得抄）；`deepseek-harness` 有 telemetry seam + 明确的分享策略（`full / feedback-only / disabled`，且必须向用户披露）。

**注意：** 对一个本地优先、隐私敏感的产品，"加遥测"不是默认对的选择。合理的最小动作是**崩溃上报 + 显式 opt-in**，而不是把 `run_events` 搬上云。抄 `cindy` 的 consent gate 形态，不要抄全量上传。

---

## 4. 建议的顺序

**不要按 §3 的编号顺序修。** 依赖关系决定了顺序：

```
① 评测               ← 必须先做。它是后面每一项的度量仪
② 沙箱与 env 收窄     ← 用户机器上的安全底线，且成本低
③ 首 token 超时       ← 挂死流的唯一解，改动面最小
④ 上下文两个缺陷 + 真 tokenizer
⑤ 文档止血
⑥ prompt cache / OTel / 覆盖率 / E2E   ← "更好"，非"必须"
```

**为什么评测排第一：** ②–⑥ 每一项都是"改了会变好"的判断，而当前没有任何东西能验证这个判断。先做 ②–⑥ 的话，你会在没有仪表的情况下调引擎。而且 §3.8 那批"半接的线"正是靠评测来防的。

**为什么沙箱排第二：** 它是唯一会**伤害用户**的缺口（不是"做得不够好"，是"可能出事"），而且第一步（收窄 `env`、修判定结构、补 `realpath`）成本很低。OS 级沙箱可以往后放。

**可以放心推迟的：** prompt cache（省钱不救命）、OTel（当前的本地观测已经够用）、覆盖率数字（对 agent 质量贡献有限）、组件测试（前端现在只覆盖纯逻辑，但纯逻辑恰好是最容易出错的部分，优先级合理）。

---

## 5. 知识补法（对着本机 `.refrences/` 读）

七个参考项目已经躺在本地，是最省力的学习路径。每条对应具体文件：

### 评测 ← 最该先学
- `deepseek-harness/packages/test-support/{llm-replay,llm-mock-server,agent-loop-testkit}` + `vitest.snapshot.config.ts` + `examples/*/retry.cordis.snapshot.yml` → **record/replay 快照**这套工程怎么做
- `sentry-mcp/packages/mcp-server-evals/src/evals/utils/{runner,toolPredictionScorer}.ts` → **LLM-as-judge 怎么判工具调用**
- 概念补齐：**任务集 / trajectory scoring / pass^k / golden set / fault injection**

> **核心认知：** agent 的测试不是"断言输出相等"，而是"断言**过程合理**"。所以判据要分层 —— 工具选对没 / 参数对没 / 最终结果对没，三层可以分别评分。recording 的价值在于让回归测试**不打真模型**也能跑出确定性 —— 这正是当前 689 个用例已经做到一半的事（它们缺的只是"用真模型录一次"）。

### 沙箱与权限
- `deepseek-harness/docs/subsystems/{sandbox,approval,permission-presets}.md` + `packages/sandbox/*` + `native/landlock-run/` → **SandboxMode 缝 + 如实上报 full/partial**
- `cc/utils/sandbox/sandbox-adapter.ts` + `cc/utils/permissions/`（约 24 文件）→ **规则引擎与网络出口控制**；另看 `cc/tools/BashTool/shouldUseSandbox.ts`
- 概念：macOS **Seatbelt / `sandbox_init`**、Linux **bubblewrap / Landlock / seccomp**、**fail-closed vs fail-open**

> **核心认知：** 路径字符串校验（Eva 现在的做法）永远挡不住符号链接与 shell 语法；只有内核级强制才算边界。以及"沙箱覆盖文件效果、不覆盖网络"是个**正当的设计选择** —— 前提是如实说出来。

### 可靠性
- `cc/services/api/withRetry.ts` + `FallbackTriggeredError` → **分阶段退避 + retry-after + 模型回落**
- `deepseek-harness/packages/llm/llm-retry/` + `.agents/notes/implemented/architecture/*bounded-llm-request-recovery*` → **把重试做成持久事件**
- 概念：jittered exponential backoff、**按阶段分超时（连接 / 首 token / 总时长）**、幂等键、熔断

> **核心认知：** 重试的正确性不在"重试几次"，而在"重试时上下文是什么状态"。`deepseek-harness` 每次重试开一个新 turn 并落一条事件，就是为了让重试**可回放、可审计**。

### 上下文工程
- `cc/services/compact/*`（注意 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`）+ `cc/services/tokenEstimation.ts`
- `deepseek-harness/packages/{compaction,spill,token-meter,session-checkpoint-policy}` → **压缩产物带 checkpoint、工具输出 spill 出去留定位符**
- `cindy/apps/desktop/src/main/embedding-host/*` + `packages/maker-core/src/memory/fts.ts` → 真 embedding + sqlite-vec + FTS5 的本地 RAG 栈（与你 SQLite 栈同构，如果要上向量检索这是最贴的参照）
- 概念：**真 tokenizer**（tiktoken / Anthropic `count_tokens`）、**tool-call / tool-result 配对不变量**、**prompt cache 的 break 点在哪**

### 可观测性
- `cc/utils/telemetry/sessionTracing.ts` → 一个 interaction span 套 LLM-request span 与 tool span
- `cindy/apps/desktop/src/main/log-upload/{consentGate,redact,sourceAllowlist,crashTriggers}.ts` → **隐私敏感产品的日志上传该长什么样**
- 概念：**OpenTelemetry GenAI semantic conventions**、成本归因

> Eva 的 `usage_records` 已经把 token 攒住了，缺的只是"定价 × token"一步。`usage/route.ts` 注释说故意砍了计价（理由是价目表会过时）—— **这个决定本身是合理的**，但要清楚代价：没有成本数字，§3.1 的评测里就少一个关键指标。

---

## 6. 需要先回答的一个问题：「学习 agent」是哪个意思

这条不是技术缺口，但它决定 §4 的顺序对不对。

`self-learn/eva` 这个路径、`docs/role/` 下的人物立绘、以及 `prompts/soul.ts` 的 `SOUL.md` 机制，指向两种可能，而两者的下一步完全不同：

**A. 这个项目是教材，目的是学 agent 开发。**
那么 §3 的清单就是课程大纲，而且**项目自身的成熟度已经够当教材** —— `2026-09-05` 那份自评审、ADR 十二条、Wave 0–6 的改造记录，本身就是很好的学习材料（比大多数教程真实）。此路下，**优先做 §3.1 和 §3.2**，因为它们是"工程判断力"的核心两课：怎么知道自己做对了，以及边界在哪。

**B. 要做的是「帮用户学习」的 agent 产品。**
那么 §3 的任何一条都不是最大缺口 —— **领域层目前是零**。全仓 `grep` 学习相关概念（间隔重复 / 课程 / 测验 / 掌握度）零命中。而且有一处**结构性**的错配值得指出：

> **agent memory ≠ learner model。**
> 当前的 `memories` 表分 `user / preference / project / decision / knowledge` 五类，这是**工程师视角** —— 记的是"用户的偏好与项目的决策"。学习者模型要记的是完全不同的一组事实："他会什么 / 哪一块卡住 / 上次在哪类问题上错 / 这个知识点隔了多久没碰 / 证据有多强"。后者需要能力维度、时间衰减、证据强度三个维度，是另一个数据模型，不是给 `memories` 加个 category 就够的。
>
> 顺带一提：当前记忆**没有向量检索**（0031 迁移把 embeddings 删了）、召回是"仅用当前用户文本做 FTS5 trigram + bm25"、且**没有任何召回质量评测**。作为工程记忆这够用；作为学习者模型的基础设施，这套检索的精度是不够的 —— 而 §3.1 正好是补它的前提。

**推荐：** 如果是 A，直接按 §4 走。如果是 B，先做 §3.1（评测），但**评测任务集要按学习场景设计** —— 因为那样"评测"就同时是"领域层的第一个组件"，一份投入两处收益。§4 的 ②–⑥ 都可以往后放。

---

## 7. 本轮验证记录

| 项 | 命令 / 方法 | 结果 |
|---|---|---|
| 架构边界 | `node scripts/check-architecture.mjs` | 8 条规则，0 error / 0 warning |
| 测试 | `node node_modules/vitest/vitest.mjs run` | 88 文件 / 689 用例通过，12.6s |
| 规模 | `find ... \| wc -l` | 源码 33 301 行；测试 15 217 行（比 0.45） |
| 并行结果缺陷 | `node --experimental-strip-types` 跑 `applyToolResultBudget`，构造 3 个并行 tool-result 的一条 `role:"tool"` 消息 + 小额预算 | **复现**：三个 part 的 `toolCallId` 全变成 `call_A`，`call_B` / `call_C` 丢失 |
| 只读放行面 | 抽出 `isSafeReadOnlyCommand` 单独运行，按**类别**验证（不记录可用验证串） | 六类形态被判为可直放，详见 §3.2 |
| 两个估算器 | 读 `context/runtime-compact.ts` / `context/tool-result-budget.ts` / `lib/token-estimator.ts` | 口径不一致，已确认 |
| 半接的线 | `grep -rn` 逐个查定义与调用者 | 10 项，见 §3.8 |
| 文档漂移 | 逐条对照 `docs/current/*` 与 `git ls-files` / 实测计数 | 7 处，见 §3.8 |
| 参考项目对照 | 读 `.refrences/` 七个项目的 README / package.json / 关键子系统 | 见 §3 各条 |

**未验证（本轮的边界）：** 真实 provider 下的 agent 质量、外部 MCP 副作用、OS 强杀恢复、长时 soak、打包产物运行、Electron 构建。上述之外的安全结论均为静态阅读所得，已在对应条目注明证据等级。
