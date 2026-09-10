# AGENTS.md

## Project Overview

Eva is a local-first AI agent desktop assistant built as a pnpm monorepo. An Electron desktop shell forks an embedded Fastify server (localhost-only), and a **Vercel AI SDK v7** agent harness (`packages/harness`) handles tool calling, skills, and memory.

## Reference Sources

`.refrences/` (gitignored) holds read-only clones of related projects. When building a feature that overlaps with one of them, search there first for implementation approaches before designing from scratch:

- `.refrences/cindy/` — XD Inc.'s desktop + mobile AI client monorepo (Electron desktop shell, agent runtime). Closest architectural neighbor to Eva.

## Architecture

```
apps/
  server/          # Fastify HTTP server (entry point, embedded in desktop)
  desktop/         # Electron shell (forks server as UtilityProcess)
  web/             # React 19 + Vite frontend
packages/
  harness/         # AI agent framework (model, agent loop, tools, prompts) — Vercel AI SDK v7
  shared/          # Shared types and utilities (server / web / harness)
tests/             # Vitest test suite
```

### Server Layer (`apps/server/src/`)

The server owns HTTP, SQLite, run lifecycle and capability assembly. The harness owns model steps and tool execution; it does not import server code.

- `app.ts` owns Fastify startup and shutdown. `deps.ts` creates infrastructure; `services/index.ts` and `api/index.ts` assemble services and route-facing operations.
- `RunCoordinator.run` accepts the input and starts the run in one transaction before asynchronous preparation. One main run per session is enforced both by admission and a partial unique index.
- `requestId` is an optional UUID reused for HTTP retries. A duplicate returns the existing run identity and status without appending another input.
- `AgentFactory.resolveModels({ modelId })` resolves the requested chat model and optional tool model. `build` assembles the run agent; no model configuration is loaded from environment variables. Model instances are cached; call settings are not cache identity.
- Assistant snapshots are updated under one message ID during execution. Finish commits the message and terminal run state together. Terminal state cannot be overwritten by a second settlement.
- `tool_operations` records intent before tool execution and result afterward. It is independent of optional observability. After restart, unfinished operations become `unknown` and are never automatically replayed. `GET /api/v1/runs/:runId` exposes the run and its operation records.
- Shutdown stops admission, cancels and drains runs, then closes MCP and SQLite. The process signal handler enforces a shutdown deadline.

### Harness Layer (`packages/harness/src/`)

- `createAgent` creates a run-loop agent. One application loop owns the working messages; each `streamText` call executes one SDK step. Continuation always uses the same working history.
- `context-strategy.ts` applies tool output budgets and automatic context compaction. The server has no independent automatic message-count/token compaction policy. User-requested session compaction remains explicit and branch-aware.
- Every tool, including per-run additions, enters one pipeline: plan policy → approval → concurrency → execution. Duplicate names are rejected. Missing approval callbacks deny dangerous tools. Cancellation does not detach execution; the loop drains dispatched tools before returning.
- Tool discovery exposes core tools and `tool_search` when a large tool set would otherwise crowd the prompt. Explicit active tool names take precedence.
- Skills expose name and description; `read_skill` loads full instructions. There is no LLM skill selection, selection table or automatic role assignment.
- Subagents are awaited tools with isolated transcripts, inherited cancellation and approval handling. Roles are a static list. They return final text through the tool result; no background launches, report tools or notice injection.
- Plan mode uses a workspace plan file and user review. The plan gate restricts ordinary write/edit paths; it is a guardrail, not a filesystem sandbox. Plan Weave has been removed.
- `web_fetch` returns Markdown in portions; it does not invoke a second model to summarize pages. SDK tool validation errors are not repaired by a hidden model call.

### Tool Convention (`packages/harness/src/tools/<kebab-case>/`)

Each tool is a **folder** named in kebab-case:

```
tools/
└── my-tool/
    ├── tool.ts          # createMyTool(config) factory — returns an AgentTool via buildTool()
    ├── client.ts        # (when needed) provider-specific client
    ├── types.ts         # (when needed) local types
    └── index.ts         # re-export
```

- Tools are built with `buildTool({ name, description, schema, execute, readOnly?, requiresApproval? })` (Zod schema, `execute` returns `string`). MCP tools use `buildJsonSchemaTool` (JSON Schema input) — both wrap errors with the shared `TOOL_ERROR_PREFIX` so `stream-part-mapper` treats the two classes the same.
- Dangerous tools set `needsApproval: true`; `createAgent` wraps their `execute` with `withApproval` so the approval gate lives at execute time (one model call, `cancelByRun` can reject pending approvals on abort). Approvals are owned by **runId**, not session.

### SSE Streaming

`POST /api/v1/runs/stream` returns Server-Sent Events. The canonical event names live in `packages/shared/src/stream-events.ts`:

```
event: run_start          — first frame: { runId, sessionId }
event: text-delta         — LLM token fragment
event: reasoning-delta    — reasoning token fragment
event: tool-input-start   — tool input streaming begins
event: tool-input-delta   — tool input streaming fragment
event: tool-call          — complete tool call (input available)
event: tool-result        — tool execution result
event: step-start         — a new model step begins
event: finish             — agent run finished { text, toolCalls, finishReason, usage? }
event: approval_request   — dangerous tool awaiting user decision
event: approval_resolved  — approval decided (user / auto / abort)
event: error              — error occurred
event: end                — stream complete (always after finish/error)
```

Every frame carries a `seq` that is strictly monotonic within a run.

## Frontend (`apps/web/`)

Vite + React 19 SPA, Tailwind CSS. Feature-sliced layout (see `docs/architecture/10-frontend-conventions.md` for the conventions; Eva's `apps/web/src` maps to 10's `src/renderer/`):

```
src/
  features/
    threads/             # chat page, message list/bubble/block, sidebar, chat-input,
                         #   use-chat/use-approvals/use-stick-to-bottom, threads api
    workspaces/          # workspace picker + use-workspaces (api/hook/component)
    settings/            # settings-layout (nested routes) + per-tab components/hooks
  shared/
    api/                 # fetch wrapper, run-stream client (SSE)
    ui/                  # Radix-based base components (popover, tooltip, resizable-sidebar)
    hooks/               # cross-feature hooks (use-models)
    markdown/            # Streamdown markdown renderer
    streaming/           # SSE accumulator + smooth-stream hook
  types/api.ts           # re-export from @eva/shared
  app.tsx                # routes (/chat, /settings/* nested)
  main.tsx               # entry
```

Settings is real routes (`/settings/models`, `/settings/providers`, `/settings/memory`, `/settings/mcp`) — no component `useState` tab switching.

### Rendering performance

- `useChat` holds `committed` (`EvaUIMessage[]`) and `streaming` (single message | null) separately. Each token only updates `streaming`; `committed`'s reference is untouched. `CommittedMessages`, `MessageBubble`, `ToolCallBlock` are `memo`'d, so streaming re-renders only the in-flight bubble.
- `useStickToBottom` follows the bottom within 80px via instant `scrollTop` (not `scrollIntoView({behavior:"smooth"})`, which jitters under per-token growth); smooth scroll only on send. A "back to bottom" button appears when scrolled away.
- `@tanstack/react-virtual` dynamic-size virtualization kicks in above 40 committed messages; the in-flight message stays outside the virtualizer.

### Approvals

Approvals are driven by the SSE `approval_request` / `approval_resolved` events (no polling). `useApprovals` calls `listApprovals()` once on mount to recover a pending approval across a refresh.

### Session

- First request: no `sessionId` → server creates session → `run_start` frame carries the new `sessionId`.
- Subsequent requests: send `sessionId` → server loads history.
- Frontend stores `sessionId` in `useState`; new conversation clears it.
- Session lifecycle: accept input/run transaction → workspace/model preparation → history → execution. Preparation failures remain recorded; a model configuration error does not delete the session.

## Workspaces & MCP

- **Workspaces** (`app.services.workspaces`): a local directory bound to a session (`sessions.workspace_id`). fs tools are injected per-run from it; `CLAUDE.md`/`AGENTS.md` under it are injected into the system prompt (16 KB cap). Paths must pass `assertUsableWorkspacePath` ($HOME and `/` rejected). Tool overflow lands in `~/.eva/tool-overflow/<workspaceId>/`, and `read_file` has a read-only whitelist for it.
- **MCP** (`app.services.mcp`, T9): DB `mcp_servers` is the only runtime source; `~/.eva/mcp.json` imports file-origin entries at startup. MCP tools are named `mcp__<server>__<tool>` and require approval unless the server declares `readOnlyHint`. A broken server degrades to `state: "error"` and never fails the chat.

## Observability (S27)

「这个 Run 到底发生了什么」是一等事实，不靠 Pino 反推：

- **`run_events`** 是可选的 append-only 诊断记录（执行事实由 runs/messages/tool_operations 保存）（`apps/server/src/db/schema.ts`，时间一律 epoch ms）。`seq` 由 **run-scoped recorder** 独占单调分配（`modules/observability/run-recorder.ts`）：同一 Run 主 Agent 与 awaited 子代理共用一个实例（`UNIQUE(run_id, seq)` 成立的唯一理由）；子代理不创建独立 Run。`record` 绝不抛回 Agent loop；payload 在 recorder 内定型（脱敏 → 截断 16 KiB → canonical JSON）。崩溃未闭合操作由启动清扫补 `operation_abandoned`，retention 按 `observability.retentionDays` / `maxDatabaseBytes` 整 Run 粒度删（`usage_records` 独立存活 —— 0030 起它没有 runs FK）。
- **事件路径**：harness `AgentTelemetryEvent` → server `createObserverBridge(recorder).forAgent(agent)`（`agent: "main" | taskId`，**没有隐式 current run**，runId 属于绑定不属于事件）→ `fanout` 合并 Pino 第二订阅者。`AgentBuildOptions.observer` / `buildSubagent.observer` 必填。
- **三段计时**:`withApproval`（审批等待）/ `withConcurrencyCap`（排队等待）/ `withExecTiming`（真实执行）汇入 run-scoped `ToolTimingState`，mapper 在 tool-result 时取快照；SSE `tool-result` 帧带 `toolExecMs/approvalWaitMs/queueWaitMs`，旧 `durationMs` 不再赋值（历史消息徽章隐藏）。abort 补发落 `tool_call_abandoned`（`duration_ms` 未分解墙钟，不伪造三段）。
- **读取面**:`GET /threads/:id/trajectory`（会话 Run 事件，三元组游标）、`GET /runs/:id/trajectory`（seq 游标，两种语义不合并）、`GET /threads/:id/session-log`(JSONL 导出，byte 稳定）。**都不进 loopback token 白名单**(`loopback.ts` 精确相等判定，改前缀匹配前先想清在放行什么）。
- **轨迹页**:`apps/web/src/features/threads/trajectory/`（会话内「对话 / 轨迹」tab，聊天流不卸载）。`derive-trajectory.ts` 纯投影（展示行不落库）+ `display-list.ts` 折叠 + 虚拟化台账（prepend 按 totalSize 差值补 scrollTop)+ 三泳道 Overview + 类型化 Inspector(snapshot 顺 `refSeq` 取调用当时那份，不是当前定义）。

## Memory

- Searchable facts live in SQLite. `save_memory` and `search_memory` are explicitly invoked tools, controlled by `settings.memory.enabled`.
- `~/.eva/MEMORY.md` and recent daily memory files are user-editable and included with bounded size. File tools remain available independently of the database memory switch.
- `autoRetrieve` performs local deterministic FTS before a Run. It searches active `global` plus current `workspace:<id>` facts across source sessions, packs a bounded prompt section, and records injected IDs in `run_memory_refs`. It does not call a query-rewrite model and never falls back to dumping all memories.
- `autoSummarize` is implemented as post-Run fact extraction (the UI calls it “自动提取”). A successful Run enqueues `memory_extraction_jobs` in the terminal transaction; enqueue errors are logged without failing the completed response. The worker stores the Run's tool model ID, resolves current provider credentials when executing, and creates reviewable `memory_candidates`. Review mode never writes automatically; automatic mode saves only candidates at or above 85% model-reported confidence. Updates check the target's revision; stale candidates return HTTP 409 instead of overwriting newer facts.
- Extraction is single-worker, abortable and bounded to three attempts with durable retry deadlines. Shutdown stops claims, aborts the active model call and returns it to the queue. Disabling memory/extraction cancels outstanding jobs. Known auxiliary model usage is recorded in `usage_records`, including schema-invalid responses.
- Explicit database tools use the same visible scopes. Project/decision saves in a workspace retain that workspace and Run/message provenance. Other-workspace IDs cannot be updated through these tools. Retrieval budgets include the prompt heading and guidance; two-character keywords use a scope-filtered substring search because trigram FTS cannot match them.
- Source session is provenance, not visibility. Deleting a session does not delete accepted memories; pending jobs tied to that Run are removed. Automatic extraction never writes `MEMORY.md`.
- There is no embedding provider, vector index, background embedding task, or hidden query rewriting.
- Historical planning documents describe retired designs. Current source and these instructions take precedence over them.

## Commands

```bash
pnpm build        # Build server + desktop shell
pnpm serve:dev    # Run the server (tsx watch)
pnpm typecheck    # tsc -p across workspaces
pnpm test         # Run all tests (vitest)
pnpm web:dev      # Start frontend dev server (Vite, port 5173)
pnpm web:build    # Build frontend for production
pnpm desktop:dev  # Run the Electron shell in dev
pnpm desktop:build# Build the desktop app
pnpm desktop:pack # Pack the desktop app for distribution
```

> **Node ≥ 22 required** — pinned by `engines.node` and `.nvmrc`, and verified by CI on
> Node 22 and 26. (`AbortSignal.any` needs ≥ 20.3, but `apps/server/tsup.config.ts`
> emits for `target: "node22"`, so 22 is the real floor.) Desktop builds ship the server
> on Electron's bundled Node — verify there before a release.
>
> **native 模块提醒**：`better-sqlite3` 必须为当前 Node 的 ABI 编译。允许它跑编译脚本的
> 开关在 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies`（必须是 YAML 列表；写成
> `'["electron"]'` 这种字符串 pnpm 不认，会让编译被静默跳过）。升级 Node 后若测试大面积
> 报 `NODE_MODULE_VERSION` 不匹配，跑 `pnpm rebuild -r better-sqlite3`。

打包链路（T11 起）：`pack` = web build → server build → `pnpm deploy .build/server-deploy`
（server 的 prod node_modules，供 external 依赖；输出落**仓库根的 `.build/`**，不落 `apps/desktop/`——
它带一份 server 的 `src/` 副本，放在源码树里会被不认 gitignore 的 `grep -rn` 搜出来冒充源码，
宪章 §7.23）→ `electron-rebuild`（better-sqlite3 按
Electron ABI）→ electron-vite。产物：`Eva.app/Contents/Resources/{app.asar, server/dist,
server/node_modules, web/dist}`。用户数据与技能在 `~/.eva/`（`~/.eva/skills/<name>/SKILL.md`
是打包态技能唯一可写位置；dev 态额外扫 monorepo 根 `skills/`）。单实例锁在多开时聚焦已有窗口。

自更新（23 篇）：electron-updater + GitHub Releases feed，mac 走 Squirrel ShipIt 整包换包。
**代码类组件（server/web/sidecar）一律随整包更新，不做组件级热更**；未来引入的重型数据
（模型权重、浏览器二进制等）不进安装包，落 `~/.eva/` 运行时按需下载。发版前跑
`pnpm --filter @eva/desktop check:release`（四类产物 zip/zip.blockmap/dmg/latest-mac.yml，
漏 blockmap = 差量静默失效）。

## Configuration

> **Model configuration does not go through environment variables.** Providers and API keys live in the `providers` table in SQLite (`~/.eva/eva.db`), managed via the Settings page; the DB is the single source of truth. Environment variables only govern process-level concerns.
>
> **API keys are encrypted at rest** (AES-256-GCM, ciphertext `enc:v1:…`). The key lives at `~/.eva/.secret-key` (0600, generated on first boot) — deleting it permanently bricks every stored apiKey (re-enter them in Settings). Lazy migration: any key update (even to the same value) encrypts that row; untouched legacy rows stay plaintext but keep working. If the key file is unreadable the server degrades to plaintext storage with a startup warning.

Environment variables loaded from `.env.local` at workspace root (`apps/server/src/config.ts`):

| Variable    | Purpose                                  |
| ----------- | ---------------------------------------- |
| `PORT`      | Server port (default 8082)               |
| `HOST`      | Server host (default 127.0.0.1)          |
| `LOG_LEVEL` | pino log level (default info)            |
| `DB_PATH`   | SQLite DB path (default `~/.eva/eva.db`) |

> Workspaces are managed in-app (not env vars). MCP config file: `~/.eva/mcp.json`.
