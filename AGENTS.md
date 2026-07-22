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

**`adapters/tdx.ts`'s `fetchDataset` no longer requires the response to be a bare JSON array.** Every TDX entry through `tw_rail` returned a bare array, so the adapter hard-coded `SCHEMA_MISMATCH` on anything else — until `tdx:metro-alert`'s real response turned out to be a single object (batch metadata + a nested `Alerts` array), see `registry/tdx.ts`'s module comment on `metroAlertEntry`. TDX doesn't have one uniform envelope shape the way CWA/MOENV do; the adapter's fail-loud check is now "must be a non-null object or array", not "must be an array" — still rejects genuinely broken payloads (a bare string/number/null), just doesn't assume every future TDX endpoint matches the shape of the ones already registered.

**When one tool needs data split across multiple upstream endpoints** (some sources publish "static" and "dynamic" halves of what's conceptually one dataset as two separate endpoints — TDX's bike-sharing data does this: `Bike/Availability/City/{City}` has live counts but no station name, `Bike/Station/City/{City}` has the name/address/capacity but no live counts): register each endpoint as its own normal `DatasetEntry` (independently useful/testable/queryable via `tw_query_dataset`), then let the *curated tool* — not a `DatasetEntry`, which is inherently one-entry-one-fetch — call `adapter.fetchDataset` once per entry and join the results client-side. `tw_youbike` (`tools/bike.ts`, `runYouBike`) is the precedent: it fetches `youBikeAvailabilityEntry` + `youBikeStationEntry` and joins by `StationUID`. Two things that pattern needs to get right, both worth copying: (1) treat the two fetches asymmetrically on failure, not as an all-or-nothing `Promise.all` — figure out which endpoint actually carries the tool's reason to exist (there, availability's bike counts) and let *that* one's failure fail the call, while a failure in the other (there, station metadata) degrades the response (e.g. falls back to an opaque id instead of a name) rather than discarding data that did arrive; (2) any client-side filter that depends on the enrichment-only endpoint (there, filtering by station name) has to be skipped — not silently applied and returning zero matches — when that endpoint failed, since a caller-visible "no results" would be indistinguishable from "the station doesn't exist." Cover the partial-failure case in tests explicitly, the same way `test/tools/bike.test.ts`'s "partial upstream failure" block does — this is exactly the kind of edge case that's easy to leave unhandled if you only ever exercise the two-fetches-both-succeed happy path.

**Not every two-entry join is this asymmetric — check whether the second fetch is enrichment or a hard prerequisite before copying tw_youbike's degrade-on-partial-failure shape.** `tw_rail` (`tools/rail.ts`, `runRail`) is the other case: TDX's TRA LiveBoard endpoint takes a numeric StationID in its URL path, not the station NAME a caller types, so `runRail` fetches `railTraStationEntry` (nationwide name→ID lookup) first, resolves the name, then fetches `railTraLiveboardEntry` with that ID. This looks structurally like tw_youbike's two-fetch join but isn't the same case: the station list isn't decorating an already-useful response the way station metadata decorates bike counts, it's the only way to know which StationID to ask for at all. If either fetch fails, or the name doesn't resolve to exactly one station, there is nothing left to degrade to — both failures (and an ambiguous/no-match name resolution) propagate and fail the whole call, a plain sequential dependency rather than an asymmetric join. When adding a new multi-endpoint tool, decide explicitly which shape applies — "does a failure in the second fetch still leave something worth returning from the first?" — and say so in the module comment either way, the same way both of these do.

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

**TDX 平台會回傳真實 HTTP 429（`API rate limit exceeded`）**，觀察到的一次情境是同一個 `fixtures-refresh.yml` 執行內短時間對多個 TDX 端點連續打請求時，其中一個端點被打了 429。這**不代表**端點路徑錯誤或資料集不存在——429 是配額問題，不是 404。遇到 429 時：直接記錄下來、稍待一段時間後重新 dispatch 即可，不要因為 429 就懷疑或改寫端點路徑（那是 404 該做的事，兩種失敗模式不要混淆）。

**shape-diff.ts 的 `shapeOf` 只檢查陣列第一筆元素的結構，這在真實世界資料波動時會造成「假陽性」的欄位增減提示。** 已至少在兩個獨立資料集上重複驗證過這個現象：`tdx:bus-eta` 的 `EstimateTime`（有/無公車即時預估，純粹取決於抓取當下路線上是否真的有車在跑）與 `cwa:W-C0034-005` 的 `MovingPrediction`（取決於當下第一筆 `Fix` 記錄是否恰好帶有移動預測文字）都曾經在不同次 dispatch 之間互相「新增」又「移除」，但欄位本身在程式碼裡本來就是（且應該維持）optional，不是真的 schema 變動。**規範**：(1) 任何依賴這類欄位的測試，斷言用的樣本資料必須手寫（引用真實欄位值即可）而非依賴 fixture 陣列的固定位置索引（例如 `fixture[0]`），否則下一次 fixture 被真實資料重新整理時測試會脆弱地壞掉——這正是 tw_rail 那次 delay-notice 修復連帶發現、修掉的問題；(2) 看到這類欄位在 schema-drift PR 裡「新增」或「移除」時，先確認程式碼是否已經把它當 optional 處理，若是，只需要更新 fixture 本身，不需要當作真正的結構變動去修 transform。

## 7. What a PR must say

1. **Files touched**, grouped by layer (infra / adapters / registry / tools / docs).
2. **New registry entries added**, if any (id, dataset, source).
3. **Any deviation from `docs/ARCHITECTURE.md`** — new interface fields, different error-code mapping than an obvious reading of the doc would suggest, anything left deliberately unimplemented (e.g. `issuedAt` unset because no dataset in this server has an unambiguous single "as of" timestamp yet).
4. **Test count before/after**, and what the new tests cover.
5. For a pure refactor (no behavior change intended): an explicit statement of what, if anything, differs in the tool's *external* behavior (response shape, error text, timing) — even things that seem like harmless improvements (e.g. adding a request timeout that didn't exist before) should be called out, not left for the reviewer to discover.
