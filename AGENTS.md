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

Three-layer dependency structure (modeled after DeerFlow):

- **`deps.ts`** — Infrastructure only: config loading, DB, skills, observer, soul-section, legacy settings migration. Getter functions for route access.
- **`services/index.ts`** — Business service assembly: wires infrastructure into `AppServices` (`agents`, `session`, `approvals`, `runRegistry`, `workspaces`, `mcp`).
- **`app.ts`** — Fastify lifecycle: creates the app, decorates with `infra` and `services`, registers routes.

Fastify decorators:

- `app.infra` — `AppInfrastructure` (config, db, logger, skills, observer?)
- `app.services` — `AppServices` (agents, session, approvals, runRegistry, workspaces, mcp)

**`AgentFactory`** (`services/agent-factory.ts`) resolves the agent **per run**:

1. `resolveModels({ requestedModelId? })` — resolves the three model slots (chat / tool / embedding) via `resolveModelSlot`; tool 缺省回落 chat; temperature is a call setting read once from settings.
2. `resolve(options)` — builds the agent with `createConfiguredAgent`, injecting per-run `workspace` context.

`LanguageModel` instances are cached keyed on (kind, providerId, baseURL, modelId, apiKey); temperature/maxOutputTokens are call settings, not part of the cache key. Provider/settings mutation routes call `agents.invalidate()`. Resolution failures throw `AgentUnavailableError` at request time (→ 503), so a fresh install with no API key still boots.

### Harness Layer (`packages/harness/src/`)

- **`AgentModel`** is `LanguageModel` from the AI SDK. `LeadAgent` drives the tool loop with `streamText({ stopWhen, prepareStep })` (the SDK drives the loop; `prepareStep` applies tool-result budget + proactive compact and hoists system messages into `instructions`).
- `stream-part-mapper.ts` translates SDK stream parts → `AgentStreamEvent`; `context-strategy.ts` builds `prepareStep`.
- Tool exposure (T43): `createAgent` injects `tool_search`. When resolved tools exceed 40 and no explicit `activeToolNames` are set, the run keeps the full `toolSet` but enters discovery mode — step 1 activates only core tools + `tool_search` via `activeTools`, and tools found by `tool_search` become active from the next step (`tool_count_degraded` still warns). Explicit `activeToolNames` always win.
- Skill exposure (T44): `SKILL.md` requires `name` / `description` / `allowed-tools` (invalid files are skipped with a warning; `always-inject` is optional). Each run auto-selects skills with the tool model, stores new selections in `session_skill_selections`, injects only selected skills' `name + description`, and merges selected `allowed-tools` as `preferredToolNames` (always plus `bash` / `read_skill` / `tool_search`) — a merge, not a replacement for the whole tool set.
- Plan Gate (T45a, workspace-only): `enter_plan_mode` creates a `plans` row plus `<workspace>/.eva/plan-gate/<planId>/current.md` (with `.eva/.gitignore` seeded to `plan-gate/` only when the file does not exist). A run-scoped `PlanGateState` feeds `withPlanGate` (outermost wrapper: it hard-blocks `write`/`edit` to non-plan paths only; bash/memory/MCP keep their normal approval semantics) and the per-step plan reminder. `exit_plan_mode` uses the existing boolean approval: approved → revision snapshot + `status=approved` + gate off; denied → gate stays on. Writes to the current plan file are auto-approved with `reason="plan-file"` via the same `matchesPlanGatePath` helper — do not bypass that shared path check. Plan Gate is a guardrail, not a sandbox.
- Plan review (T45b): `exit_plan_mode` has a parallel `requestPlanReview` channel (the boolean `RequestApproval` path for ordinary tools is untouched). Decisions are `approve / revise / reject / reject_and_exit / dismissed` (+ user `feedback` / `selectedLabel`), stored on `approval_requests.kind='plan_review'` + `decision` JSON, and `reject` / `reject_and_exit` set a run-scoped `shouldStopTurn` read by the `stopWhen` predicate. `cancelByRun` and startup stale sweeps map plan-review pendings to `dismissed` (ordinary tool pendings still become `denied`). The web UI renders a separate `PlanReviewCard` (never the risk-colored approval card), and `exit_plan_mode` must never gain an always-allow policy key.
- Subagents were a half-built scaffold and have been **removed**; fork-join will be rebuilt from scratch in S7.

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
- Dangerous tools set `requiresApproval: true`; `createAgent` wraps their `execute` with `withApproval` so the approval gate lives at execute time (one model call, `cancelByRun` can reject pending approvals on abort). Approvals are owned by **runId**, not session.

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
- Session lifecycle: request reordered to session/workspace → agent → context (see `routes/runs.ts` `openSessionTurn` → `resolve` → `buildRunContext`); a 503 on a freshly created session rolls it back.

## Workspaces & MCP

- **Workspaces** (`app.services.workspaces`): a local directory bound to a session (`sessions.workspace_id`). fs tools are injected per-run from it; `CLAUDE.md`/`AGENTS.md` under it are injected into the system prompt (16 KB cap). Paths must pass `assertUsableWorkspacePath` ($HOME and `/` rejected). Tool overflow lands in `~/.eva/tool-overflow/<workspaceId>/`, and `read_file` has a read-only whitelist for it.
- **MCP** (`app.services.mcp`, T9): DB `mcp_servers` is the only runtime source; `~/.eva/mcp.json` imports file-origin entries at startup. MCP tools are named `mcp__<server>__<tool>` and require approval unless the server declares `readOnlyHint`. A broken server degrades to `state: "error"` and never fails the chat.

## Plan Weave (T46)

Workspace 级文件型任务图（与 Plan Gate 的 `.eva/plan-gate/` 目录刻意拉开，互不共享文件）：

- 状态在 `<workspace>/.eva/plan-weave/`（`plan.json` + `state.json` + `results/`），archive 落到 `.eva/plan-weave-archive/<ts>-<slug>/`；路径只在 `apps/server/src/paths.ts` 拼。**不写进 `.gitignore`** —— 进 git 是有意的（人可直接改、可追踪）。
- block 状态机 `pending → ready → in_progress → done`（旁路 `blocked`）；**ready 不是持久字段**，每次读写按 deps 重算，手改 `plan.json` 能自愈。`state.json` 的 `current` 必带 `owner: runId`；`submit` 后让出坑位等 review，`done/reset/archive` 都必须清 `current`。
- 写盘全部 tmp→fsync→rename 原子写；**另有 per-workspace in-process mutex**（`PlanFileStore.withLock`）防跨 `await` 的 read-modify-write lost update —— 去掉它并发 submit 测试必红。
- review：`needs_changes` 必带 notes 且 block 回 `ready`、`reviews+1`；达 `maxReviewCycles` 自动关门放行并在 review 文件里留痕「已达上限，强制通过」。open feedback 永远优先于新 block；`resolve` 写 `FB-N.resolution.md` 关闭。
- 11 条 REST 挂在 `/api/v1/workspaces/:id/plan...`（不接 `dir`，避免任意路径入口）；6 个内置工具 `plan_create/plan_status/plan_claim/plan_submit/plan_review/plan_resolve`（`packages/harness/src/tools/plan-weave/`），工具工厂吃 `PlanWeaveGateway`，server 侧直接调 service —— **不过 HTTP、不带 token**。
- 工具**入参不带任何路径**（workspaceId/runId 在 runs.ts 绑进 gateway，无 workspace 不注入），这是「不设 `needsApproval`」站得住的理由；只有 `plan_status` 是 `readOnly`（误标会被 T24 只读并发帽放行，绕过 mutex 的串行意图）。
- 首版只有 REST，无 WS 广播、无 UI 面板（plan 是 workspace 级，per-run SSE 帧会漏给别的会话）。

## Memory (T16)

Memory is split across two stores by scale and access pattern (the "file as database" philosophy, docs 14 §11):

- **DB (L4)**: `memories` table + `memory_embeddings` (vec0) + FTS. Tools: `save_memory` / `search_memory`. Hundreds-to-thousands of searchable facts; gated by Settings → Memory (`settings.memory.enabled`).
- **Human-readable files (L1/L2)**: `~/.eva/MEMORY.md` (long-term, injected every turn, 8 KB cap) and `~/.eva/memory/YYYY-MM-DD.md` (recent 2 days injected). Tools: `read_memory_file` / `append_memory` / `update_long_term_memory`. These are **user-editable** — `MEMORY.md` is what "you can open it in an editor and fix it" means. Always mounted (not gated by `settings.memory.enabled`); the routing rule lives in `agent.ts`'s `MEMORY_PROMPT_SECTION`.

The prompt tells the model the one decisive question — _"is this fact worth spending tokens on every single turn?"_ — Yes → `update_long_term_memory`, No → `save_memory`; day-stamped ephemera → `append_memory`.

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

> Node ≥ 20.3 required (harness uses `AbortSignal.any` in the tool abort/timeout
> wiring, r6 T25). Desktop builds ship the server on Electron's bundled Node —
> verify there before a release.

打包链路（T11 起）：`pack` = web build → server build → `pnpm deploy .server-deploy`
（server 的 prod node_modules，供 external 依赖）→ `electron-rebuild`（better-sqlite3 按
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
