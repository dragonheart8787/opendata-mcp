# ADR-001: Layered architecture (tools / registry / adapters / infra)

## Status

Accepted — implemented in this session.

## Context

The server started as three self-contained files under `src/tools/`, each one owning its own fetch-and-parse logic, its own copy of error handling, and (for MOENV) its own missing-value normalization. That was fine for three tools against two sources.

Per `docs/ARCHITECTURE.md`, the roadmap adds several more sources (TDX, WRA, and long-tail `data.gov.tw` sets) and up to ~15 curated tools plus a generic `tw_search_datasets` / `tw_query_dataset` pair. Under the flat structure, every new dataset would mean copy-pasting a whole fetch+parse+cache+error-handling file and hoping the copy doesn't drift from the original — exactly the kind of duplication that made the MOENV bare-array bug (fixed in an earlier PR) tedious to track down: the fetch logic, the error handling, and the domain shaping were all tangled together in one file, so verifying "is this parsed correctly" meant reading through auth, retries, and JSON shaping all at once.

## Decision

Split the pipeline into four layers, each with one job:

- **`infra/`** — runtime-agnostic building blocks with no knowledge of CWA, MOENV, or any specific dataset: an HTTP client with timeout+retry, a KV cache wrapper, the response envelope, and the shared `ToolError` type.
- **`adapters/`** — one file per upstream source (`cwa.ts`, `moenv.ts`). Owns auth injection, URL assembly, and unwrapping that source's specific response envelope/quirks (CWA's `{success, records}`, MOENV's bare array and `"" / "-" / "ND"` missing-value markers) into plain "raw JSON". Two sources today; three points to a `tdx.ts` doing the same in Phase 3.
- **`registry/`** — one `DatasetEntry` per dataset: its Zod param schema, how those params map to the upstream's own query params, and a `transform(raw, params)` that shapes the adapter's raw JSON into the compact structure a tool returns. This is where "add a dataset" work concentrates.
- **`tools/`** — thin MCP glue: cache the transform's output, wrap it in the success/failure envelope, return the MCP tool result. Should almost never need editing once a registry entry exists for a new dataset that fits an already-registered tool's shape.

Adding a dataset to an *existing* source now costs: one registry entry + one transform + one fixture + one test — no new fetch/auth/error-handling code, because the adapter is shared. Adding a *new source* costs one adapter file, reused by every dataset registered under it.

## Consequences

**Upside**: the MOENV-class of bug (wrong assumption about response shape, discovered only in production) is now caught by adapter-level tests in isolation, without needing to also mock a specific tool's params or cache behavior. `runWeatherForecast` / `runRecentEarthquakes` / `runAirQuality` are preserved as thin composition functions (adapter + transform) so the pre-refactor test suite mostly needed only import-path updates, not rewritten assertions — that safety net is what made this refactor tractable in one session.

**Downside / cost paid now**: three more directories and files to navigate for what's still a 3-tool server; a new contributor has to understand four layers instead of one file per tool. Two extensions to the architecture doc's draft interfaces were necessary to preserve exact tool behavior — see the PR description for the layered-architecture PR for the specifics (`transform` gaining a `params` argument; `DatasetEntry` gaining `buildQueryParams`) — both are additive within what the doc already allows ("DatasetEntry 至少包含...").

**Explicitly deferred** (Phase 1's "Session B" and later, not this session): the fixtures-fetching CI pipeline and schema-drift detection, `tw_search_datasets` / `tw_query_dataset`, `gen-tools-doc`, and moving `test/fixtures/` to a top-level `fixtures/` directory. The registry's `registerEntry`/`getDatasetEntry`/`listDatasetEntries` lookup functions exist now and are tested, but nothing in this session's three tools actually looks datasets up by id — they still import their specific registry entry directly. That's intentional: the lookup-by-id path is Phase 3's `tw_query_dataset` use case, wired up early so that session doesn't also need to touch this layer.
