# AGENTS.md — working rules for this repo

Read this together with `docs/ARCHITECTURE.md` before starting any session. This file is the enforceable checklist; the architecture doc is the reasoning behind it. Where they disagree, the architecture doc's *principles* win but this file's *interfaces* are what the code actually implements (see the deviations noted below — they're intentional and this file documents the canonical, as-built interface).

---

## 1. Directory structure

```
src/
  index.ts        # Worker entry point, MCP server assembly, routing — no fetch/parsing logic
  tools/          # One file per curated tool. Thin: cache -> envelope -> MCP result.
  registry/       # One DatasetEntry per dataset, grouped by source (cwa.ts, moenv.ts, ...)
  adapters/       # One file per upstream source: auth, URL assembly, envelope unwrapping
  infra/          # http.ts, cache.ts, envelope.ts, errors.ts — no CWA/MOENV-specific code
test/             # Mirrors src/'s layout (test/adapters/, test/registry/, test/tools/, test/infra/)
  fixtures/       # Real captured response samples (see §5)
docs/
  ARCHITECTURE.md
  adr/            # ADR-NNN-slug.md, numbered sequentially
AGENTS.md         # this file
```

**Layer responsibilities** (see ADR-001 for why):
- `infra/` never imports from `adapters/`, `registry/`, or `tools/`.
- `adapters/` never does dataset-specific filtering/shaping — only auth injection, URL building, timeout+retry (via `infra/http.ts`), and unwrapping that source's response envelope into "raw JSON". Missing-value normalization that's a *source* quirk (like MOENV's `"" / "-" / "ND"`) belongs here, generically, not per-dataset.
- `registry/` entries do the dataset-specific shaping (`transform`) and own the Zod param schema. No fetch calls here.
- `tools/` compose cache + envelope on top of a registry entry's adapter+transform. No parsing logic here.

## 2. Core interfaces (as-built, not the doc's literal draft)

```ts
// registry/index.ts
export interface DatasetEntry<TParams, TRaw, TResult> {
  id: string;                    // "cwa:F-C0032-001"
  source: "cwa" | "moenv";       // add sources here as adapters are added
  path: string;                  // upstream dataset id/path, used to build the URL
  title: string;
  keywords: string[];            // for the future tw_search_datasets
  paramsSchema: Record<string, ZodTypeAny>;  // Zod raw shape — reused directly as the MCP tool's inputSchema
  buildQueryParams: (params: TParams) => Record<string, string | undefined>;
  transform: (raw: TRaw, params: TParams) => TResult;
  cacheTtlSeconds: number;
  updateFrequency: string;       // human-readable, surfaced in the response envelope
  docUrl: string;
  notes?: string;
}

// adapters/types.ts
export interface SourceAdapter {
  id: "cwa" | "moenv";
  displayName: string;           // "中央氣象署" etc, used as the envelope's `source`
  fetchDataset<TParams, TRaw>(
    entry: DatasetEntry<TParams, TRaw, unknown>,
    params: TParams,
    env: Env,
    fetchImpl?: typeof fetch     // DI seam for tests, defaults to global fetch
  ): Promise<TRaw>;
}
```

**Two deliberate extensions beyond `docs/ARCHITECTURE.md`'s draft types** (both disclosed in the PR that introduced this layer):
1. `transform` takes `(raw, params)`, not just `(raw)`. Filtering by the caller's params — which county, how many earthquakes, client-side re-filtering when an upstream `filters` param isn't reliably honored — is explicitly transform's job per the doc, which is impossible without the params.
2. `DatasetEntry.buildQueryParams` isn't in the doc's minimal field list (which the doc itself says is "at least" these fields). The adapter has no generic way to know that our `city` param means CWA's `locationName`, or that MOENV wants `filters=field,EQ,value` — that mapping is dataset-specific and lives on the entry.

If a future session needs a third extension to make a new source/dataset behave correctly, add it the same way: implement it, disclose it in the PR, update this file.

## 3. Tool description: five-segment rule

Every tool's `description` must contain, in this order:
1. **One-sentence purpose**, naming the source agency and dataset id (e.g. "查詢中央氣象署（CWA）「今明 36 小時天氣預報」（資料集 F-C0032-001）...").
2. **Parameter notes**, including format traps (CWA's "臺" not "台", MOENV's county-vs-siteName mutual exclusivity, etc).
3. **適用情境** (when to use this tool) — concrete example questions.
4. **不適用** (when NOT to use this tool) — what it can't answer.
5. **資料範圍限制** (scope limits) — e.g. "僅涵蓋顯著有感等級以上地震", "非即時，每小時更新". If a limit isn't obvious from the tool's purpose, it must be spelled out here rather than left for the caller to discover from an empty/wrong result — see `tw_recent_earthquakes`'s description for the reasoning (empty result ≠ "no earthquakes happened", it means "none met the 顯著有感 threshold").

**Annotations are non-negotiable** — every tool registration uses exactly:
```ts
annotations: {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
}
```
This server has no write tools and never will (see architecture doc §0 non-goals).

## 4. Testing requirements

- **Every `transform`** gets a test in `test/registry/<source>.test.ts` driven by a fixture in `test/fixtures/`, covering: the happy path, the not-found/empty-result case, and any dataset-specific edge case (e.g. air quality's client-side re-filter, earthquake's max-intensity-across-areas logic).
- **Every adapter** gets a test in `test/adapters/<source>.test.ts` covering: missing API key -> `AUTH_MISSING`, invalid key / 401/403 -> `AUTH_MISSING`, network failure -> `UPSTREAM_ERROR`, malformed/unexpected response shape -> `SCHEMA_MISMATCH`, and (for MOENV-style sources) missing-value normalization.
- **Every `infra/` module** gets its own unit tests independent of any dataset (see `test/infra/`).
- Prefer testing `transform`/adapter logic directly (fast, no fetch mocking needed for transform) over only testing through the full MCP `tools/call` round-trip. Keep a handful of `test/index.test.ts` end-to-end tests (initialize, tools/list, one success + one failure envelope shape) as the integration safety net, not the primary coverage mechanism.
- A refactor that doesn't add a dataset/tool must leave the existing test count >= what it started with, and all pre-existing assertions passing (see the layered-architecture PR for what this looks like in practice — every pre-existing test was preserved, most just needed an import-path update).

## 5. Fixtures

- Real captured response samples, ideally byte-verbatim from production (Cloudflare Logs or a direct authenticated call), not hand-written guesses. If you only have a partial/truncated capture, use it for the fields you have and clearly comment which fields are still reconstructed placeholders (see `test/tools/air-quality.test.ts`'s fixture comment for the pattern).
- A fixture that turns out to be wrong (wrong shape, wrong field casing) is exactly the failure mode ADR-001 exists to make cheaper to fix — when you find one, fix the fixture, the adapter/transform, and note it in the PR, don't just patch around it.

## 6. Known upstream behavior patterns

**CWA 與 MOENV 的政府開放資料 API，其查詢篩選參數（如 `filters`、`county`、`locationName` 等）不可信任一定生效。** 已在以下三筆資料集上獨立驗證過上游忽略篩選、回傳完整未過濾清單的情況：
- `moenv:aqx_p_432`（空氣品質，`county`/`siteName` 篩選）
- `cwa:F-A0021-001`（潮汐預報，`locationName` 篩選）
- `cwa:O-A0001-001`（氣象觀測，`locationName` 篩選）

**規則**：任何新增資料集的 adapter/transform，只要該資料集支援依地點/測站等條件查詢，一律不得只依賴上游篩選，必須在拿到回應後於 `transform` 或 adapter 層做 client-side 重新過濾，即使上游文件宣稱該參數有效。

**測試規範**：針對有 client-side 過濾邏輯的資料集，測試裡應包含一個「上游回傳未過濾完整清單」的情境，斷言 transform 依然正確篩出目標子集——這樣以後如果有人不小心把過濾邏輯優化掉，測試會抓到（見 §4 的測試要求）。

**CWA 海象類資料集（浮標站、波浪、潮位）已知與本專案統一使用的 `/api/v1/rest/datastore/` 端點不相容。** `F-A0012-001` 與 `O-B0076-001` 兩次獨立嘗試皆在真實 dispatch 中回傳真實 HTTP 404，研判這類資料是走獨立的 `ocean.cwa.gov.tw`／`oceanapi.cwa.gov.tw` 平台（不同的認證與資料集代碼格式）。**除非未來發現該平台有相容的 API 形式，否則不要再嘗試接入海象類資料集**——重複嘗試已驗證過兩次的失敗模式，不會有新結果。

## 7. What a PR must say

1. **Files touched**, grouped by layer (infra / adapters / registry / tools / docs).
2. **New registry entries added**, if any (id, dataset, source).
3. **Any deviation from `docs/ARCHITECTURE.md`** — new interface fields, different error-code mapping than an obvious reading of the doc would suggest, anything left deliberately unimplemented (e.g. `issuedAt` unset because no dataset in this server has an unambiguous single "as of" timestamp yet).
4. **Test count before/after**, and what the new tests cover.
5. For a pure refactor (no behavior change intended): an explicit statement of what, if anything, differs in the tool's *external* behavior (response shape, error text, timing) — even things that seem like harmless improvements (e.g. adding a request timeout that didn't exist before) should be called out, not left for the reviewer to discover.
