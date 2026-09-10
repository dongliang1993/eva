# Server / harness refactor progress

This is the completed implementation checkpoint for the server/harness execution-core refactor. It is not a release sign-off; real-provider and long-running acceptance remain separate release work.

## Implemented

- One application step loop; each SDK call executes one step. Continuation retains the full working history.
- Every per-run tool passes through the same approval, concurrency, timing and plan policy pipeline. Duplicate names fail during assembly; absent approval handlers deny dangerous tools.
- Session input and run acceptance share a transaction. Active main runs are additionally constrained by a partial unique index. Terminal updates require a running row.
- History and manual compaction follow the selected ancestor chain and exclude child transcripts. An incompatible checkpoint is not reused.
- Skills expose their metadata without a per-run LLM selection call or selection table.
- Subagents are awaited tools, inherit cancellation and approval handling, and return final text. Background launch, report injection and notice-driven continuation are removed. Roles are static configuration.
- Assistant messages are checkpointed at tool/step boundaries and updated under the same message ID.
- Tool execution intents and results are written directly to `tool_operations`, independently of optional diagnostics. Restart marks unfinished executions `unknown`; they are not automatically replayed.
- Tool pipelines drain dispatched executions before the run is released. Tool wrappers no longer race execution against a detached cancellation result. Read-only queue waits can be cancelled.
- Shutdown rejects new runs, aborts and drains active runs, then closes MCP and SQLite. The process signal handler has a 10-second forced-exit deadline.
- Workspace writes serialize across runs. Overwrite/edit use a same-directory temporary file and rename; this preserves complete-file visibility. This does not lock external editors or turn workspace tools into a filesystem sandbox.
- Failure attribution comes from execution events, not observer callbacks. Diagnostic context overflow events no longer mutate model configuration.
- SSE slow-subscriber buffering is bounded, and disconnect clears its heartbeat.

- Removed Plan Weave task graphs, claim/review workflow, gateways, tools and REST routes. Plan file approval remains.
- Removed the old hidden query-rewrite/embedding recall path, inactive auto-summary flag, background reindex, sqlite-vec and the embedding model slot. Explicit search/save and editable files remain; the replacement automatic memory flow is described below.
- Removed startup settings compatibility migrations and skill selection flags.
- Automatic compaction now belongs to the harness loop; server message-count/token triggers are removed. Explicit user-requested compaction remains.
- Initial persisted history is eligible for compaction on the first model step; only synthetic per-run context is protected as a fixed prefix.

- Removed RunScope and merged run control flow. Exceptions save partial messages; model configuration failures no longer delete sessions.
- Added requestId deduplication and GET /runs/:runId for terminal state and operation receipts. Streaming text checkpoints at one-second intervals.
- Removed model-based tool repair and web-page summarization; web_fetch returns paginated Markdown.
- A run freezes its MCP/memory capabilities and resolved chat/tool model bindings once; awaited children reuse those exact snapshots.
- Tool operation identities are scoped by `(runId, agent, toolCallId)`, so provider call IDs cannot collide between main and child agents.
- Removed child-Run lineage and background-task API/UI paths. Awaited child state is stored only as a subagent task plus isolated transcript inside the parent Run.
- Updated AGENTS.md to the current architecture.
- Added bounded cross-session automatic memory retrieval using local FTS (`global` + current workspace), with per-Run provenance in `run_memory_refs`.
- Added durable post-Run memory extraction jobs and review candidates. Review mode requires acceptance; automatic mode only saves candidates with confidence >= 85%, using stable scope/key upserts and source provenance.

## Memory follow-up audit (2026-09-10)

- Worker shutdown aborts the active extraction and preserves queued work for restart, without draining the backlog. Disabling database memory or automatic extraction cancels outstanding jobs and prevents an in-flight result from being saved.
- Failed extraction calls retry with persisted 1-second / 2-second backoff, then fail after three attempts. Restart recovers interrupted work and settles exhausted jobs. Only the current claim can settle; deleted source sessions and duplicate completion cannot create memories.
- Extraction and review writes compare the target memory revision. An edited/deleted target or an unseen fact with the same scope/key is not overwritten; automatic conflicts become review candidates, and stale acceptance returns HTTP 409.
- Explicit memory tools use the same global/current-workspace boundary and record source session, run and message IDs. A workspace-scoped extraction without a workspace is discarded rather than promoted to global.
- Retrieval budgets include the complete injected section, including its heading and preamble. Exact two-character keywords have a scoped substring fallback because the trigram index cannot match them; empty queries do not dump the memory list.
- Auxiliary extraction usage is recorded separately in the shared usage ledger, including known usage for rejected structured outputs. The job freezes its model ID; current provider credentials are resolved at execution time.
- The settings review panel exposes fetch/accept errors, can refresh pending candidates, and explains the additional model usage.

## Verification

- 2026-09-10: architecture checker passed all 8 rules; all workspace typechecks passed; Vitest passed 85 test files / 655 tests.
- Server and web production builds passed. Desktop TypeScript passed; Electron packaging was not rerun. Vite still reports the pre-existing large-chunk warning.
- The globally installed pnpm stalled while activating the project version, so workspace commands used the already cached pnpm 10.30.3 executable; architecture checks and Vitest ran directly with Node. No package-manager configuration was changed.
- `git diff --check`: passed.

## Remaining release validation

- Run the fixed agent-quality task set against real configured providers.
- Validate automatic memory extraction precision, review usability, and cross-session recall relevance with real providers and representative Chinese conversations. Unit/integration tests use injected extractors and do not establish extraction quality.
- Exercise real external MCP side effects and cancellation behavior.
- Perform OS hard-kill/restart recovery and longer soak tests.
- Decide separately whether to code-split the current ~1.1 MB web entry chunk; this is not part of the execution-core refactor.

These automated checks establish the repository contract, but do not replace the real-provider, external-side-effect, hard-kill, and soak validation above.
