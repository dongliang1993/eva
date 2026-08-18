# eva

Local-first AI agent desktop assistant (Electron + Fastify + SQLite). Built as a pnpm monorepo, modeled after Alma / WeaveLynx-style agent harnesses.

The Electron desktop shell forks an embedded Fastify server as a child `UtilityProcess` on a dynamic localhost port; the renderer talks to it over HTTP/SSE. Storage is better-sqlite3 + drizzle + sqlite-vec + FTS5.

> **Status**: the harness runs on **Vercel AI SDK v7** (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai-compatible`). Messages are stored as AI SDK `UIMessage` (single JSON column), and the agent loop is driven by `streamText({ stopWhen, prepareStep })`. See [Roadmap](#roadmap) for what's done and what's next.

## Architecture Docs

In-depth architecture research + landing plan live in [`docs/architecture/`](./docs/architecture/README.md) — a 16-doc series (00–15, 12 missing):

- **00–08**: Alma/WeaveLynx teardown — process model, frontend, Electron, backend+DB, agent harness, memory, multi-agent, replication roadmap.
- **09**: extension slot host design (manifest/exposes.json, UI + capability slots, EH, webview SDK).
- **10**: frontend conventions (features/shared/slots, kebab naming, reuse boundary decision tree, ESLint).
- **11**: one-by-one landing plan (S0–S17, Phase A–E) with fixed decisions (local-first / Vercel AI SDK + Anthropic / macOS arm64).
- **13**: work-mi→eva reuse assessment (the base this repo was built from).

Per-task implementation plans live in [`docs/plans/`](./docs/plans/): S1 harness→Vercel AI SDK migration, Claude-Code-style compaction design.

Active task tracking: see the **Roadmap** section below and `docs/architecture/11-landing-plan.md`.

## Workspace Layout

```text
apps/
  server/               Fastify server entrypoint (embedded in desktop)
  desktop/              Electron shell (forks server as UtilityProcess)
  web/                  React 19 + Vite frontend
packages/
  harness/              Agent harness (model, agent loop, tools, prompts, skills)
  shared/               Shared types, contracts, and utility helpers
docs/
  architecture/         Architecture research + landing plan (16 docs)
  plans/                Design and implementation documents
tests/                  Root-level Vitest coverage
```

## Architecture

Modular monolith inside a `pnpm` workspace. Server layer is three-tier (modeled after DeerFlow):

- `deps.ts` — infrastructure: config, db, skills, soul section, work-root.
- `services/index.ts` — service assembly: `AgentFactory`, `SessionService`, `ApprovalGateway`, `RunRegistry`.
- `app.ts` — Fastify lifecycle: decorates `infra` + `services`, registers routes.

The harness (`packages/harness`) drives the tool loop with `streamText({ stopWhen, prepareStep })` (no hand-rolled step loop), proactive/reactive runtime compact, tool-result budget, max-output continuation recovery, observer telemetry, and SKILL.md progressive disclosure. (Subagents were a half-built scaffold and have been removed; fork-join will be rebuilt in S7.)

## Quick Start

```bash
cp .env.example .env.local   # set TARGET_REPO_ROOT to a project dir for fs tools
pnpm install
pnpm typecheck
pnpm test
pnpm serve:dev               # server only (tsx watch)
pnpm web:dev                 # web (Vite) only
pnpm desktop:dev             # Electron shell + server + web
```

Configure an LLM provider + API key + default model in the Settings page (stored in `~/.eva/eva.db`). Model config does not go through env vars.

## Core Environment Variables

Loaded from `.env.local` (gitignored) at the workspace root:

| Variable | Purpose |
|----------|---------|
| `HOST` | API bind host — use `127.0.0.1` (do NOT use `0.0.0.0`, exposes to LAN) |
| `PORT` | API port (default 8082) |
| `LOG_LEVEL` | pino log level (default info) |
| `TARGET_REPO_ROOT` | Work root for fs tools (read/write/edit/bash/grep/list). Must be an explicit project dir; empty = no fs tools; `$HOME`/`/` rejected. |
| `DB_PATH` | SQLite DB path (default `~/.eva/eva.db`) |

> Model config (providers, API keys, default model, temperature) lives in the `providers` table in SQLite, managed via the Settings page — not env vars.

## API Endpoints

- `GET /v1/health` — service health
- `POST /api/v1/runs/stream` — SSE streaming agent run
- `POST /api/v1/runs/:runId/abort` — abort a run
- `GET/POST /api/v1/threads` — session/thread CRUD
- `GET /api/v1/threads/:id/messages` — thread messages (UIMessage[])
- `POST /api/v1/threads/:id/compact` — manual compaction
- `GET/POST /api/v1/providers` — LLM provider management
- `GET/POST /api/v1/memories` — long-term memory CRUD + search
- `GET /api/v1/skills` — skill list
- `GET/PUT /api/v1/settings` — app settings
- `GET/POST /api/v1/tool-approvals` — dangerous-tool approval gate
- `GET /api/v1/search/threads` — full-text thread search

## Roadmap

Based on `docs/architecture/11-landing-plan.md`, calibrated to eva's current state (base reused from work-mi; Sentry/Wave/local-agent subsystems already removed). Tasks tracked as S0–S17 across Phase A–E.

| Phase | Task | Status | Acceptance |
|---|---|---|---|
| A | **S0** Foundation (desktop fork server + dynamic port + health probe + shell-env + proxy) | ✅ Done | `curl /v1/health` → 200; server forks as UtilityProcess |
| A | **S1** Talking shell — migrate harness LangChain→Vercel AI SDK + Anthropic; SSE chunk forwarding | ✅ Done (r1/T0–T2) | streaming text, no stutter; `@ai-sdk/anthropic` provider |
| A | **S1.1** Frontend streaming three-red-lines (seq reorder / rAF char pump / Streamdown block memo) | ✅ Done (r1/T3) | no stutter on token burst; only tail block re-renders |
| A | **S2** Storage + version tree (UIMessage whole-store + parent/slot/depth) | 🟡 Data done (r1/T1), UI next | restart keeps history; regenerate → switchable versions |
| A | **S3** Project workspace (workspaces table + import repo + CLAUDE.md injection) | ⬜ | import a repo; agent cwd = workspace.path |
| A | **S4** Tools + agent loop + approval (Read/Write/Edit/Bash + tool-overflow + approval gate) | ✅ Done (r1/T0.3/T0.4) | "create hello.txt with a poem" → created; Bash/Write approved first |
| B | **S5** Skill mechanism (SKILL.md 3-level progressive disclosure) | ✅ Mostly done | write a skill → agent loads full text on demand |
| B | **S6** Extension host + slots (manifest/exposes.json + EH + 4 UI slots + agentPlugin) | ⬜ | hello-ext renders in appSidebar; agent calls its tool |
| B | **S7** Subagents + fork-join (Task/TaskOutput + background + resume + depth limit) | ⬜ | fork 3 background agents, join all; subagent uses toolModel |
| B | **S8** MCP integration (mcp.json + `mcp__server__tool` dynamic registration) | ⬜ | connect an MCP server; agent calls its tool |
| C | **S9** Git review panel (diff/commit/push/worktree/MR as an extension) | ⬜ | view diff; commit+push+open MR (= S6 acceptance extension) |
| C | **S10** Datasource Gateway abstraction (database RPC + external HTTP proxy + AK/SK) | ⬜ | register external datasource; agent queries via Gateway |
| D | **S11** Desktop polish (electron-updater + tray + global shortcut + deep link + single instance) | ⬜ | dmg installs; Alt+Space唤起; `eva://` deep link |
| E | **S12–S17** Flavor (memory/persona/heartbeat/activity-recorder/multi-channel/voice) | ⬜ | optional, orthogonal to coding platform |

Critical path: **S1 → S2 → S3 → S4 → S6 → S9**. See `docs/architecture/11-landing-plan.md` §8 for the full dependency graph.

## Notes

- **Local-first**: server binds to `127.0.0.1` only. No remote exposure without adding a token + TLS layer.
- **Security**: `.env.local` is gitignored; API keys never committed. `HOST=0.0.0.0` is rejected (LAN exposure).
