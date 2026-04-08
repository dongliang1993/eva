# eva

Local-first AI agent desktop assistant (Electron + Fastify + SQLite). Built as a pnpm monorepo, modeled after Alma / WeaveLynx-style agent harnesses.

- Electron desktop shell forks an embedded Fastify server (localhost-only).
- Vercel-AI-SDK-style agent harness with tool calling, subagents, skills, memory, and compaction.
- better-sqlite3 + drizzle + sqlite-vec + FTS5 storage.

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
  plans/                Design and implementation documents
tests/                  Root-level Vitest coverage
```

## Recommended Architecture

This repo is a modular monolith inside a `pnpm` workspace. The desktop app forks the server as a child UtilityProcess on a dynamic localhost port; the renderer talks to it over HTTP/SSE. This keeps deployment and debugging simple while preserving package boundaries.

## Quick Start

```bash
cp .env.example .env.local
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

## Core Environment Variables

- `HOST`: bind host for the API; use `127.0.0.1` locally (do NOT use `0.0.0.0` — exposes to LAN)
- `PORT`: API port (default 8082)
- `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`: LLM provider credentials
- `WEB_FETCH_MODEL`: model used for web-fetch summarization
- `TARGET_REPO_ROOT`: default repository root for code context

## API Endpoints

- `GET /v1/health`: service health
- `POST /api/v1/runs/stream`: SSE streaming agent run
- `GET/POST /api/v1/threads`: session/thread CRUD
- `GET/POST /api/v1/providers`: LLM provider management

## Notes

- The default LLM adapter uses LangChain + OpenAI through `packages/harness`. (Planned: migrate to Vercel AI SDK + Anthropic.)
- Local-first: the server binds to 127.0.0.1 only. No remote exposure without adding a token + TLS layer.
