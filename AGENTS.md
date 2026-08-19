# AGENTS.md

## Project Overview

Eva is a local-first AI agent desktop assistant built as a pnpm monorepo. An Electron desktop shell forks an embedded Fastify server (localhost-only), and a **Vercel AI SDK v7** agent harness (`packages/harness`) handles tool calling, skills, and memory.

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

打包链路（T11 起）：`pack` = web build → server build → `pnpm deploy .server-deploy`
（server 的 prod node_modules，供 external 依赖）→ `electron-rebuild`（better-sqlite3 按
Electron ABI）→ electron-vite。产物：`Eva.app/Contents/Resources/{app.asar, server/dist,
server/node_modules, web/dist}`。用户数据与技能在 `~/.eva/`（`~/.eva/skills/<name>/SKILL.md`
是打包态技能唯一可写位置；dev 态额外扫 monorepo 根 `skills/`）。单实例锁在多开时聚焦已有窗口。

## Configuration

> **Model configuration does not go through environment variables.** Providers and API keys live in the `providers` table in SQLite (`~/.eva/eva.db`), managed via the Settings page; the DB is the single source of truth. Environment variables only govern process-level concerns.

Environment variables loaded from `.env.local` at workspace root (`apps/server/src/config.ts`):

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default 8082) |
| `HOST` | Server host (default 127.0.0.1) |
| `LOG_LEVEL` | pino log level (default info) |
| `DB_PATH` | SQLite DB path (default `~/.eva/eva.db`) |

> Workspaces are managed in-app (not env vars). MCP config file: `~/.eva/mcp.json`.
