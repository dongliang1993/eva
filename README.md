# eva

Local-first AI agent desktop assistant (Electron + Fastify + SQLite). Built as a pnpm monorepo, modeled after Alma / WeaveLynx-style agent harnesses.

The Electron desktop shell forks an embedded Fastify server as a child `UtilityProcess` on a dynamic localhost port; the renderer talks to it over HTTP/SSE. Storage is better-sqlite3 + drizzle + sqlite-vec + FTS5.

> **Status**: the harness runs on **Vercel AI SDK v7** (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai-compatible`). Messages are stored as AI SDK `UIMessage` (single JSON column), and the agent loop is driven by `streamText({ stopWhen, prepareStep })`. See [Status](#status) for what's done and what isn't.

## Docs

| 想知道 | 读这个 |
|---|---|
| 今天的架构（进程、模块、依赖方向） | [`docs/current/architecture.md`](./docs/current/architecture.md) |
| 一次对话在服务端怎么跑 | [`docs/current/run-lifecycle.md`](./docs/current/run-lifecycle.md) |
| 某份状态谁拥有、事实源在哪 | [`docs/current/data-ownership.md`](./docs/current/data-ownership.md) |
| 某条约束为什么存在 | [`docs/adr/`](./docs/adr/README.md)（C1–C12 十二条架构宪法） |
| 代码里 `T48` / `S27` 指的是什么 | [`docs/archive/plans/`](./docs/archive/plans/README.md) |
| Alma 竞品研究与早期设计快照 | [`docs/archive/research/`](./docs/archive/research/README.md)（**不是** Eva 的架构） |

`AGENTS.md` 是同一批事实的操作向摘要。冲突时以 `docs/current/` 为准。

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
  current/              What the code looks like today (the only "facts" entry point)
  adr/                  Stable decisions (why it is this way, when to overturn it)
  plans/                In-flight construction plans (task numbers live only here)
  archive/              Competitor research + finished construction rounds
scripts/                Repo-level tooling (check-architecture.mjs = `pnpm lint:arch`)
tests/                  Root-level Vitest coverage, mirroring the module tree
```

### Build artifacts — do not read these, do not grep these

None of the directories below hold source. They are build output or vendored copies,
all gitignored, and several contain **stale duplicates of real source files** — a
`grep -rn` that ignores `.gitignore` will happily return a version of the code that
stopped being true months ago.

| Directory | What it is |
|---|---|
| `.build/server-deploy/` | `pnpm deploy` output for packaging (includes a copy of `apps/server/src/`) |
| `apps/*/dist/`, `apps/desktop/dist-electron/` | compiler output |
| `apps/desktop/release/` | packed `Eva.app`, dmg/zip installers |
| `.refrences/` | read-only clones of related projects, for reference only |
| `node_modules/` | dependencies |

`.vscode/settings.json` excludes all of them from editor search and file watching;
`scripts/check-architecture.mjs` skips them too. If you add a new artifact directory,
add it in both places.

## Architecture

Modular monolith inside a `pnpm` workspace. Server layer is three-tier (modeled after DeerFlow):

- `deps.ts` — infrastructure: config, db, skills, observer.
- `services/index.ts` — service assembly: `AgentFactory`, `SessionService`, `ApprovalGateway`, `RunRegistry`, …
- `api/index.ts` — the composition root: the only place that `new`s a repository; builds `AppApi`.
- `app.ts` — Fastify lifecycle: decorates `infra` / `services` / `api`, registers routes.

Business code lives in 17 vertical modules under `apps/server/src/modules/<capability>/`,
each with a single public entry (`index.ts`). Routes can only see `app.api` — not `db`.
See [`docs/current/architecture.md`](./docs/current/architecture.md).

The harness (`packages/harness`) drives the tool loop with `streamText({ stopWhen, prepareStep })` (no hand-rolled step loop), proactive/reactive runtime compact, tool-result budget, max-output continuation recovery, observer telemetry, and SKILL.md progressive disclosure. Subagents (fork-join, background tasks, report gateway) are in place.

## Quick Start

```bash
cp .env.example .env.local
pnpm install
pnpm typecheck
pnpm test
pnpm serve:dev               # server only (tsx watch)
pnpm web:dev                 # web (Vite) only
pnpm desktop:dev             # Electron shell + server + web
```

Configure an LLM provider + API key + model slots in the Settings page (stored in `~/.eva/eva.db`). Model and workspace config do not go through env vars — workspaces are added in-app.

## Core Environment Variables

Loaded from `.env.local` (gitignored) at the workspace root:

| Variable | Purpose |
|----------|---------|
| `HOST` | API bind host — use `127.0.0.1` (do NOT use `0.0.0.0`, exposes to LAN) |
| `PORT` | API port (default 8082) |
| `LOG_LEVEL` | pino log level (default info) |
| `DB_PATH` | SQLite DB path (default `~/.eva/eva.db`) |

> Model config (providers, API keys, model slots) lives in the `providers` table in SQLite, managed via the Settings page — not env vars. Workspaces are the in-app equivalent of the old `TARGET_REPO_ROOT`.

## API Endpoints

All routes are registered from `apps/server/src/routes/index.ts`, each one owned by its
module's `route.ts`. Grouped by capability:

| Capability | Endpoints |
|---|---|
| Runs | `POST /api/v1/runs/stream`（SSE）、`GET /api/v1/runs/:runId/stream`（重新挂上）、`POST /api/v1/runs/:runId/abort` |
| Threads | `GET/POST /api/v1/threads`、`GET/DELETE /api/v1/threads/:id`、`/messages`、`/status`、`/usage`、`/compact`、`/workspace`、`/subagent-messages` |
| Messages | `POST /api/v1/messages/:id/switch-version` |
| Approvals | `GET /api/v1/tool-approvals`、`POST /api/v1/tool-approvals/:callId`、`.../plan-review`、`POST /api/v1/approval-policies/grant` |
| Providers & models | `GET/POST /api/v1/providers`、`/:id`(PUT/DELETE)、`/:id/{api-key,models,models/fetch,test}`、`GET /api/v1/models`、`GET /api/v1/provider-catalog` |
| Settings & skills | `GET/PUT /api/v1/settings`、`GET /api/v1/skills` |
| Memory | `GET/POST /api/v1/memories`、`/:id`(PUT/DELETE)、`/search`、`/stats`、`/reindex` |
| Workspaces | `GET/POST /api/v1/workspaces`、`/:id`(PUT/DELETE)、`POST /api/v1/workspaces/pick-directory` |
| Plan Weave | `GET/POST/DELETE /api/v1/workspaces/:id/plan` + `claim`/`submit`/`review`/`resolve`/`reset`/`blocked`/`archive`/`block` |
| MCP | `GET/POST /api/v1/mcp-servers`、`/:id`(PUT/DELETE)、`/:id/reconnect` |
| Observability | `GET /api/v1/threads/:id/trajectory`、`GET /api/v1/runs/:id/trajectory`、`GET /api/v1/threads/:id/session-log` |
| Search & usage | `GET /api/v1/search/threads`、`GET /api/usage/stats` |
| System | `GET /v1/health` |

除只读/静态白名单外，操作面都要带 loopback token（`x-eva-token`，桌面壳每次启动重新生成）。

## Status

功能上：对话、消息版本树、工作区、审批、Skill、MCP、记忆、Plan Gate / Plan Weave、
子代理、轨迹页、自更新都已落地 —— 逐项形态见
[`docs/current/architecture.md`](./docs/current/architecture.md)。

结构上：架构改造 Wave 0–6 已于 2026-08-31 收尾（依赖方向与模块入口由 `pnpm lint:arch` 强制，
9 条规则 0 error / 0 warning；主链五文件可读；current 文档与 ADR 就位）。
改造总纲与每个 Wave 的实测尾注在
[`docs/archive/plans/25-eva-simple-architecture-charter.md`](./docs/archive/plans/25-eva-simple-architecture-charter.md)。

尚未动的方向（都不在当前计划里）：扩展槽位宿主（旧编号 S6）、Git review 面板（S9）、
Datasource Gateway（S10）、以及人格/心跳/多通道那一类 flavor 能力（S12–S17）。
它们的早期设计在 `docs/archive/research/`，**读之前先知道那是当时的目标，不是今天的代码**。

## Notes

- **Local-first**: server binds to `127.0.0.1` only. No remote exposure without adding a token + TLS layer.
- **Security**: `.env.local` is gitignored; API keys never committed. `HOST=0.0.0.0` is rejected (LAN exposure).
