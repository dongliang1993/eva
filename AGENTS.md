# AGENTS.md

## Project Overview

Eva is a local-first AI agent desktop assistant built as a pnpm monorepo. An Electron desktop shell forks an embedded Fastify server (localhost-only), and a LangChain-based agent harness handles tool calling, subagents, skills, and memory.

## Architecture

```
apps/
  server/          # Fastify HTTP server (entry point, embedded in desktop)
  desktop/         # Electron shell (forks server as UtilityProcess)
  web/             # React 19 + Vite frontend
packages/
  harness/         # AI agent framework (model, agent loop, tools, prompts)
  shared/          # Shared types and utilities
tests/             # Vitest test suite
```

### Server Layer (`apps/server/src/`)

Three-layer dependency structure (modeled after DeerFlow):

- **`deps.ts`** — Infrastructure only: config loading, low-level clients. Getter functions for route access.
- **`services/index.ts`** — Business service assembly: wires infrastructure into API services (RunApiService, SessionService) and the main agent.
- **`app.ts`** — Fastify lifecycle: creates the app, decorates with `infra` and `services`, registers routes.

Fastify decorators:
- `app.infra` — `AppInfrastructure` (config, db, skills)
- `app.services` — `AppServices` (runs, session)

### Harness Layer (`packages/harness/src/`)

- **`AgentModel`** interface with `invoke()` and `stream()` methods
- **`WorkMiAgent`** interface with `run()` (sync) and `stream()` (SSE) methods
- **`LeadAgent`** implements the agent loop with tool calling
- Streaming uses manual tool_call metadata tracking to handle LangChain `concat` compatibility issues with non-standard OpenAI-compatible APIs

### Tool Convention (`apps/server/src/tools/`)

Each tool is a **folder** named in PascalCase:

```
tools/
└── MyTool/
    ├── constants.ts      # TOOL_NAME and shared constants
    ├── description.ts    # getDescription() — structured tool description for LLM guidance
    └── index.ts          # createXxxTool() factory function
```

Rules:
- Folder name matches the tool concept in PascalCase (e.g. `WebSearch`, `ReadFile`)
- `constants.ts` exports `TOOL_NAME` (snake_case string used as the tool identifier)
- `description.ts` exports `getDescription()` returning a multi-line string with "When to use" guidance and output format
- `index.ts` exports the `createXxxTool(config, ...deps)` factory function
- Tool schema uses Zod with `.describe()` on parameters that accept multiple input formats

### SSE Streaming

`POST /api/v1/runs/stream` returns Server-Sent Events:

```
event: text_chunk        — LLM token fragments
event: tool_call_start   — tool invocation begins
event: tool_call_end     — tool invocation completes
event: result            — final agent result
event: error             — error occurred
event: end               — stream complete
```

## Frontend (`apps/web/`)

Vite + React 19 SPA, Tailwind CSS.

### Component Naming & Organization

- **File naming**: kebab-case — `message-bubble.tsx`, `chat-input.tsx`, `tool-call-block.tsx`
- **Simple components**: single file — `components/message-bubble.tsx`
- **Complex components** (>200 lines or multiple sub-files): folder with index —
  ```
  components/chat-view/
    index.tsx           # main component, re-exported
    use-scroll-anchor.ts  # local hook
    types.ts            # local types
  ```
- **Hooks**: `hooks/use-chat.ts` (kebab-case, `use-` prefix)
- **API layer**: `api/client.ts`

### React Best Practices

Follow Vercel React performance guidelines (`~/.claude/skills/vercel-react-best-practices/`):
- `async-parallel` — Use `Promise.all()` for independent operations
- `bundle-barrel-imports` — Import directly, avoid barrel files
- `rerender-defer-reads` — Don't subscribe to state only used in callbacks
- `rerender-functional-setstate` — Use functional setState for stable callbacks
- `rerender-no-inline-components` — Don't define components inside components
- `rendering-conditional-render` — Use ternary, not `&&` for conditionals
- `js-early-exit` — Return early from functions

### Directory Structure

```
src/
  pages/                    # Page-level layout + routing (one folder per route)
    settings/index.tsx
    <new-route>/index.tsx
  components/               # Reusable UI components
    ui/                     # Radix-based base components (popover, tooltip, etc.)
    settings/               # Settings-specific components
    chat-input/             # Complex component folder (>200 lines)
      index.tsx
      select-model/index.tsx
    message-bubble.tsx      # Simple component (single file)
  hooks/                    # Custom hooks
  api/                      # API client + fetch wrapper
  styles/                   # CSS (Tailwind + theme tokens)
```

- **`pages/`** — page-level components that compose layout + sub-components. One folder per route.
- **`components/`** — reusable, route-agnostic components. Pages import from here.
- Never put page routing logic in `components/`.

### SSE Streaming

Use `fetch` + `ReadableStream` for SSE (not `EventSource`, because we need POST).
Events: `text_chunk`, `tool_call_start`, `tool_call_end`, `result`, `error`, `end`.

### Session

- First request: no `sessionId` → server creates session → returns `sessionId` in response
- Subsequent requests: send `sessionId` → server loads history
- Frontend stores `sessionId` in `useState`; new conversation = clear it

## Commands

```bash
pnpm build    # Build the server (tsup)
pnpm test     # Run all tests (vitest)
pnpm web:dev  # Start frontend dev server (Vite, port 5173)
pnpm web:build # Build frontend for production
```

## Configuration

Environment variables loaded from `.env.local` at workspace root:

| Variable | Purpose |
|----------|---------|
| `LLM_API_KEY` | LLM API key |
| `LLM_BASE_URL` | LLM API base URL (for non-OpenAI providers) |
| `LLM_MODEL` | Model name (default: `gpt-4.1-mini`) |
| `LLM_TEMPERATURE` | Temperature (default: `0.1`) |
| `WEB_FETCH_MODEL` | Model used for web-fetch summarization |
| `TARGET_REPO_ROOT` | Repository root for code context matching |
| `INTERNAL_IM_SIGNING_SECRET` | HMAC signing secret for IM webhooks |
