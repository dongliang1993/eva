# eva

Local-first AI agent desktop assistant (Electron + Fastify + SQLite). Built as a pnpm monorepo, modeled after Alma / WeaveLynx-style agent harnesses.

The Electron desktop shell forks an embedded Fastify server as a child `UtilityProcess` on a dynamic localhost port; the renderer talks to it over HTTP/SSE. Storage is better-sqlite3 + drizzle + sqlite-vec + FTS5.

> **Status**: scaffolding. The agent harness currently uses **LangChain** (`@langchain/core` + `@langchain/openai`). The planned next step is migrating it to **Vercel AI SDK + `@ai-sdk/anthropic`** — see [Roadmap](#roadmap).

## Architecture Docs

In-depth architecture research + landing plan live in [`docs/architecture/`](./docs/architecture/README.md) — a 14-doc series (00–13):

- **00–08**: Alma/WeaveLynx teardown — process model, frontend, Electron, backend+DB, agent harness, memory, multi-agent, replication roadmap.
- **09**: extension slot host design (manifest/exposes.json, UI + capability slots, EH, webview SDK).
- **10**: frontend conventions (features/shared/slots, kebab naming, reuse boundary decision tree, ESLint).
- **11**: one-by-one landing plan (S0–S17, Phase A–E) with fixed decisions (local-first / Vercel AI SDK + Anthropic / macOS arm64).
- **13**: work-mi→eva reuse assessment (the base this repo was built from).

Active task tracking: see the **Roadmap** section below and `docs/architecture/11-landing-plan.md`.

## Workspace Layout

```text
apps/
  server/               Fastify server entrypoint (embedded in desktop)
  desktop/              Electron shell (forks server as UtilityProcess)
  web/                  React 19 + Vite frontend
packages/
  harness/              Agent harness (model, agent loop, tools, prompts, skills, subagents)
  shared/               Shared types, contracts, and utility helpers
docs/
  architecture/         Architecture research + landing plan (14 docs)
  plans/                Design and implementation documents
tests/                  Root-level Vitest coverage
```

## Architecture

Modular monolith inside a `pnpm` workspace. Server layer is three-tier (modeled after DeerFlow):

- `deps.ts` — infrastructure: config, db, skills, soul section.
- `services/index.ts` — service assembly: `RunApiService`, `SessionService`, agent resolver.
- `app.ts` — Fastify lifecycle: decorates `infra` + `services`, registers routes.

The harness (`packages/harness`) has a hand-written agent loop (maxSteps + tool-call回灌), proactive/reactive runtime compact, tool-result budget, max-output continuation recovery, observer telemetry, subagents, and SKILL.md progressive disclosure.

## Quick Start

```bash
cp .env.example .env.local   # then fill in LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
pnpm install
pnpm typecheck
pnpm test
pnpm dev                     # server only (tsx watch)
pnpm web:dev                 # server + web (Vite) together
pnpm desktop:dev             # Electron shell + server + web
```

## Core Environment Variables

Loaded from `.env.local` (gitignored) at the workspace root:

| Variable | Purpose |
|----------|---------|
| `HOST` | API bind host — use `127.0.0.1` (do NOT use `0.0.0.0`, exposes to LAN) |
| `PORT` | API port (default 8082) |
| `LLM_API_KEY` | LLM provider API key |
| `LLM_BASE_URL` | LLM API base URL (for non-OpenAI providers) |
| `LLM_MODEL` | Model name (default `gpt-4.1-mini`) |
| `LLM_TEMPERATURE` | Temperature (default 0.1) |
| `WEB_FETCH_MODEL` | Model used for web-fetch summarization |
| `TARGET_REPO_ROOT` | Default repository root for code context |
| `INTERNAL_IM_SIGNING_SECRET` | HMAC signing secret for IM webhooks |

## API Endpoints

- `GET /v1/health` — service health
- `POST /api/v1/runs/stream` — SSE streaming agent run
- `POST /api/v1/runs/wait` — non-streaming agent run
- `GET/POST /api/v1/threads` — session/thread CRUD
- `GET /api/v1/threads/:id/messages` — thread messages
- `POST /api/v1/threads/:id/compact` — manual compaction
- `GET/POST /api/v1/providers` — LLM provider management
- `GET/POST /api/v1/memories` — long-term memory CRUD + search
- `GET /api/v1/skills` — skill list
- `GET/PUT /api/v1/settings` — app settings
- `GET /api/v1/search/threads` — full-text thread search

## Roadmap

Based on `docs/architecture/11-landing-plan.md`, calibrated to eva's current state (base reused from work-mi; Sentry/Wave/local-agent subsystems already removed). Tasks tracked as S0–S17 across Phase A–E.

| Phase | Task | Status | Acceptance |
|---|---|---|---|
| A | **S0** Foundation (desktop fork server + dynamic port + health probe + shell-env + proxy) | ✅ Done | `curl /v1/health` → 200; server forks as UtilityProcess |
| A | **S1** Talking shell — migrate harness LangChain→Vercel AI SDK + Anthropic; SSE chunk forwarding | ⬜ Next | streaming text, no stutter; `@ai-sdk/anthropic` provider |
| A | **S1.1** Frontend streaming three-red-lines (seq reorder / rAF char pump / Streamdown block memo) | ⬜ | no stutter on token burst; only tail block re-renders |
| A | **S2** Storage + version tree (UIMessage whole-store + parent/slot/depth) | ⬜ | restart keeps history; regenerate → switchable versions |
| A | **S3** Project workspace (workspaces table + import repo + CLAUDE.md injection) | ⬜ | import a repo; agent cwd = workspace.path |
| A | **S4** Tools + agent loop + approval (Read/Write/Edit/Bash + tool-overflow + approval gate) | ⬜ | "create hello.txt with a poem" → created; Bash/Write approved first |
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
- The harness currently uses LangChain; the Vercel AI SDK migration (S1) is the next planned step.
