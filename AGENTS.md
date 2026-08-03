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

**TDX 平台會回傳真實 HTTP 429（`API rate limit exceeded`）**，觀察到的一次情境是同一個 `fixtures-refresh.yml` 執行內短時間對多個 TDX 端點連續打請求時，其中一個端點被打了 429。這**不代表**端點路徑錯誤或資料集不存在——429 是配額問題，不是 404。遇到 429 時：直接記錄下來、稍待一段時間後重新 dispatch 即可，不要因為 429 就懷疑或改寫端點路徑（那是 404 該做的事，兩種失敗模式不要混淆）。`scripts/fixtures/refresh-fixtures.ts` 對每筆 check 之間有 `INTER_CHECK_DELAY_MS`（750ms，適用所有來源）的基礎延遲，TDX 額外再加 `TDX_EXTRA_DELAY_MS`（1500ms）——後者是在同一 750ms 延遲仍連續踩到 429（含同一天內對相同新端點的兩次獨立嘗試）之後才加上的，因為 TDX 的每個 entry 都各自打一次 token + 一次資料請求，實際請求量是 CWA/MOENV 單一 entry 的兩倍。即使有這個延遲，同一天內密集重複 dispatch（例如反覆診斷同一個新端點）仍可能再次踩到 429——遇到時的優先處理方式是「記錄、等、換一個獨立情境測試（例如暫時停用其他 entry 的 sampleParams 做隔離測試）」，而不是無限重試同一個完整 dispatch。若 TDX entry 數量持續增加、連 1500ms 都不夠，下一步緩解手段是把 TDX 的 fixtures-refresh 拆成獨立的 job/dispatch，而不是繼續加長單一延遲值。

**同樣密集使用下，TDX 的 OAuth token 端點本身也觀察過回傳真實 HTTP 500（不是資料端點，是認證伺服器）**，且會讓同一次 dispatch 內「每一個」TDX entry 同時失敗（因為每個 TDX entry 都各自獨立打一次 token）。這也**不代表**任何一個資料集路徑或欄位有問題——如果同一次 dispatch 裡所有 TDX entry 同時、同樣地失敗，先假設是 TDX 認證伺服器暫時性問題（很可能與當天稍早對同一組 TDX_CLIENT_ID 的高頻使用有關），不要逐一排查每個資料集的路徑。

**`tdx:road-traffic-cms` 只有可變訊息標誌的「設置位置」，沒有「目前顯示內容」，也不是「道路交通事件」資料集——這是查證過的結論，不是待補的缺口。** 已針對這兩個方向做過 WebSearch（含 TDX 官方文件、第三方介接教學、兩個獨立的 TDX API 包裝套件原始碼：Python 的 nycu-tdx-py、R 的 ChiaJung-Yeh/NYCU_TDX）：(1) 找不到任何「CMS 內容」端點——TDX 的 Road Traffic v2 群組裡沒有回傳看板目前顯示文字的資源；(2) 找不到任何 TDX 原生的「道路交通事件」REST 端點——唯一相關的東西是 R 套件裡呼叫 `tisvcloud.freeway.gov.tw/history/motc20/Event.xml` 的函式，但那**不是** TDX API：不同主機、不需要 TDX 的 OAuth、XML 格式、且只涵蓋國道（不含市區道路，與這筆 CMS entry 的縣市涵蓋範圍不對等）。這個國道事件資料後來確實以全新 source／adapter 的形式收錄了——見下面 `highway:live-events`（`adapters/highway.ts`、`registry/highway.ts`）——但走的是 `tisvcloud.freeway.gov.tw`（交通部高速公路局『交通資料庫』），不是 TDX，兩者是完全獨立的平台，不要混淆或試圖把 highway 的端點塞進 TDX 的 registry/adapter 慣例裡。**除非 TDX 自己的平台未來新增了相容於現有 TDX registry 慣例的端點，否則不要重複在 TDX 內搜尋這兩個方向**——已經驗證過的負面結果，重查不會有新答案。

**`tisvcloud.freeway.gov.tw`（交通部高速公路局『交通資料庫』，`highway:live-events` 的來源）對雲端/資料中心來源 IP 會靜默中斷連線，且分開於「拒絕不遵守 robots.txt 的擷取工具」這兩件事同時存在，不要混為一談。** 已驗證：(1) 這個 sandbox 的 proxy、以及 GitHub Actions 的 hosted runner（Azure IP），兩者對這個主機的每一個請求都精準卡在逾時秒數上（不是快速拒絕）——這是雲端來源 IP 被靜默丟包的典型特徵，不是路徑錯誤（路徑錯誤會很快收到 404）；(2) 獨立於 (1)，這個主機也會拒絕遵守 robots.txt 語意的擷取工具（WebFetch、多數瀏覽器/爬蟲），但接受純粹的 HTTP GET（不管 robots.txt）——這解釋了為什麼用 WebSearch/WebFetch 查證這個平台自己的文件時屢屢碰壁（403），不是文件不存在，是擷取工具本身進不去。這兩種阻擋機制的來源可能不同（IP 層 vs. 應用層 User-Agent/行為判斷），**兩者都要記住，混淆會導致誤判「這個來源不可行」而放棄**。目前唯一確認能連到這個主機的環境是本專案部署後的 Cloudflare Worker 本身（見下一則筆記）。

**查證一個文件/第三方資料都不可靠、或這個 sandbox 連不上的全新來源時，比起反覆用 WebSearch/WebFetch 猜測、或靠記憶硬填端點路徑，更有效率的做法是：暫時在 `src/index.ts` 加一個一次性除錯路由（例如 `GET /debug/probe-xxx`），部署到 Cloudflare 之後直接從正式環境的真實出口打請求，把回應（狀態碼、內容預覽）回傳出來檢視，驗證完就整個移除。** 這是 `highway:live-events` 這次的實際經驗：根目錄猜測（`cctv_value.xml.gz` 等第三方線索）全部猜錯，只有在加了 debug 路由、部署後對正式環境依序探測 root → `/history/` 等候選路徑、並把擷取範圍對準真正的 `id="indexlist"` 表格（而非整段冗長的使用須知文字）之後，才在真實回應裡看到 `LiveEvents.xml` 這個真實檔名。**適用時機**：(a) 這個 sandbox 或 GitHub Actions 確認連不到目標主機（不確定的話，先用一次探測而不是預設放棄）；(b) 目標平台的文件頁面對擷取工具不友善（403、JS 渲染、找不到明確的端點清單）。**紀律**：debug 路由要在程式碼註解裡明確標記「TEMPORARY，合併前必須移除」，驗證完成、真正的 registry entry 寫好之後，移除步驟本身也要是這次 PR 的一部分，不要留著「以後再清」。

**`highway:live-events` 從 GitHub Actions 完全連不上（見上面的靜默中斷筆記），`scripts/fixtures/refresh-fixtures.ts` 因此把 `highway` 來源設計成「允許抓取失敗、不擋 CI」**：`KNOWN_UNREACHABLE_FROM_CI_SOURCES` 集合裡的來源，抓取失敗只會記錄進摘要（標明「已知從 CI 環境連不上，不視為異常」），不會讓 `hadFetchFailure` 成立、也不會讓整個 script 以非零狀態碼結束——這跟其他來源的抓取失敗（會被視為需要人工關注的異常）刻意不同。這個平台自己的使用規範明文規定「重複擷取同一檔案的週期間距應大於 40 秒」（硬性限制，官方可逕行中斷違規連線），對應到兩處設計：(1) 本伺服器自己的快取 TTL（`HIGHWAY_LIVE_EVENTS_CACHE_TTL_SECONDS = 60`）本來就以「符合官方自報的 `UpdateInterval`」為準，已經保守高於 40 秒門檻；(2) `refresh-fixtures.ts` 比照 `TDX_EXTRA_DELAY_MS` 的做法加了 `HIGHWAY_EXTRA_DELAY_MS`（40000ms），目前只有一筆 highway entry，同一次 dispatch 內沒有實際效果，但為未來可能新增的第二筆 highway entry（例如 `LiveTraffic.xml`）預留正確的節流間距，不用等到真的加了才臨時補。**這個來源結構驗證因此不能靠 fixtures-refresh 走 GitHub Actions**——真正的驗證只能靠部署後在正式環境（Cloudflare Workers）直接測試，比照上一則筆記的 debug-probe 做法。

**`infra/http.ts` 的 timeout 過去只涵蓋「拿到回應標頭」，不涵蓋讀取 body 的階段——已修正（`httpGetWithBody`），但這不是任何一次真實逾時事件的根因，是查證時連帶發現、確認值得修的架構缺口。** 原始 `request()` 在 `fetchImpl(...)` resolve（即回應標頭到達）的當下就呼叫 `clearTimeout(timer)`，但每個 adapter 都是在這之後才呼叫 `.json()`/`.text()` 讀 body——這段完全不在 AbortController 的保護範圍內。對 CWA/MOENV/TDX 這向來是隱形的（body 都是小型、單一縣市/測站範圍的 JSON，讀取時間可忽略），直到 `highway:live-events`（每次都要抓「全國未經上游篩選的完整 XML」，body 大小天生沒有上限）才第一次有可能真的踩到這個缺口。**修正方式**：新增 `httpGetWithBody`（不是改寫既有的 `httpGet`/`httpPost`，兩者的 headers-only 行為完全不變，CWA/MOENV/TDX 不用改）——它讓同一個 abort timer 在 `readBody` 也完成之後才清除，讓 `timeoutMs` 真正涵蓋整個請求（標頭+body），不只是標頭。這個機制之所以成立：真實 fetch 實作裡，中止一個仍在讀取 body 的請求，會讓該讀取的 stream 一併被中止、拋出 AbortError（`test/infra/http.test.ts` 用真的 `ReadableStream` 驗證了這個行為，不是用 `new Response(string)` 這種跟 abort signal 毫無關聯的捷徑斷言）。`adapters/highway.ts` 已改用這個新函式。

**`tw_highway_traffic` 逾時排查最終結論（第四輪，取代下面曾經寫過的「一次性網路雜訊」結論——那個結論後來被真實證據推翻，不要重新採信）：根因是上游 `tisvcloud.freeway.gov.tw` 的真實回應時間，已經現在進行式地逼近甚至超過 5 秒，不是任何程式碼邏輯層、也不是 MCP 協定層的問題。** 排查順序：(1) 先懷疑上游 fetch/XML 解析——debug 路由直測 `tisvcloud.freeway.gov.tw`，量到 fetch-to-headers 315ms、body 讀取與 XML 解析都約 0ms，**當時**排除了這個理論；(2) 懷疑快取/並發——debug 路由直呼叫真正的 adapter/registry/cache 函式並分段計時，量到全程最慢 917ms、並發互不拖慢，**排除**快取層與並發；(3) 基於前兩輪都排除、且「只有 highway 逾時、其他工具正常」不利於「共用 MCP 協定層」這個假設，一度**錯誤地**結論為「一次性網路雜訊」——這個結論後來被使用者回報的「連續五次呼叫、每次都逾時、錯誤一致」直接推翻（五次連續一致不可能是雜訊）；(4) 重新排查時，**這次沒有繞過真正的呼叫路徑或協定層**：在 `src/index.ts` 真正的 `server.registerTool("tw_highway_traffic", ...)` callback 裡插入計時（不是另外呼叫一份邏輯），並在 `transport.handleRequest(...)` 前後計時，透過 opt-in 的 `x-debug-timing` request header 把結果附加到真正 `tools/call` JSON-RPC 回應上；再從 GitHub Actions（sandbox 連不到正式環境的 `*.workers.dev`，同樣的理由見 `scripts/smoke-test.mjs` 的模組註解）對正式環境送出 6 次真實 `tools/call` 請求。**真實數字**：`mcpBeforeCallbackMs`（callback 執行前，含 request 解析與 schema 驗證）與 `mcpAfterCallbackMs`（callback 回傳後，含回應序列化）在全部 6 次呼叫裡都是 0ms——MCP 協定層完全不是瓶頸；100% 的耗時都在 `toolCallbackMs`（工具自己的 callback，含快取/上游 fetch/轉換）內。其中 2 次呼叫的 `toolCallbackMs` 分別是 10090ms、10003ms（精準對應 `httpGetWithBody` 兩次嘗試各自都撞到 5000ms 的 abort 上限，兩次都失敗，最終真的以 `UPSTREAM_TIMEOUT` 回傳給呼叫端——不是內部量測異常，是真實使用者會看到的逾時錯誤），第 3 次呼叫是 5435ms（第一次嘗試在 5000ms 被中止、第二次嘗試約 435ms 就成功，靠 retry 僥倖救回來），後 3 次呼叫因為前一次剛寫入快取而在個位數 ms 內命中快取。**修法**：把 `adapters/highway.ts` 呼叫 `httpGetWithBody` 的 `timeoutMs` 從沿用 infra 預設的 5000 提高到 9000（只調整這個 adapter 的呼叫端參數，`infra/http.ts` 的預設值與其他 adapter 不變）——5435ms 那次「差點失敗」的真實數字，加上兩次「兩次嘗試都撞牆」的真實數字，代表現在的上游真實延遲已經不穩定地逼近甚至超過 5 秒，5000ms 的單次嘗試預算已經不足以吸收正常的延遲波動；9000ms 讓一次「慢但沒有真的掛掉」的上游回應有機會在第一次嘗試就完成，不用保證性地撞牆重試。這不保證完全消除逾時（我們只能從「撞到上限而失敗」的樣本反推，無法得知真實上游延遲的完整分布），是根據目前實測數字做的比例調整，不是隨意加大的數字；如果之後仍有逾時回報，代表真實延遲的尾端比 9 秒更長，需要重新用同一套方法（真實 `tools/call` + 分段計時）量測，而不是再猜。

（以下這段結論在第四輪排查後已知有誤，保留是為了記錄排查過程本身，不要重新採信其結論）**這次 `httpGetWithBody` 的修正，是一次「查證時發現的真實架構缺陷，但排查後確認跟事發的實際問題無關」的案例，兩者要分開記錄，不要因為修了東西就默認是原因。** 真實事件：`tw_highway_traffic` 連續三次呼叫逾時，其他工具（天氣、search_datasets）正常。完整排查順序：(1) 先懷疑上游 fetch/XML 解析——用 debug 路由直接對 `tisvcloud.freeway.gov.tw` 量測，真實數字是 fetch-to-headers 315ms、body 讀取與 XML 解析都約 0ms，遠低於 5 秒 timeout，**排除**這個理論；(2) 但這個 debug 路由繞過了真正的呼叫路徑（快取讀寫、client-side 篩選、格式化），所以又做了第二個 debug 路由，直接呼叫真正的 adapter/registry/cache 函式（不是另外重寫一份邏輯）並分段計時，外加併發測試——真實數字是全程最慢 917ms、併發呼叫互不拖慢，**排除**快取層與並發是原因；(3) 兩輪真實數據都排除了程式碼邏輯層面的問題，唯一還沒被這兩次 debug 路由涵蓋到的是 MCP 協定層本身（schema 驗證、`McpServer`/transport 生命週期）——但這層是所有工具共用的通用程式碼，並非 highway 專屬，而真實事件裡「其他工具都正常、只有這個工具逾時」這個選擇性現象，本身就是不利於「共用協定層」這個假設的證據。**結論（已知有誤，見上）**：這次連續三次逾時很可能是那次呼叫當下的一次性網路雜訊（例如 `tisvcloud.freeway.gov.tw` 本身、或 Cloudflare 到它的路由，短暫地慢或不穩定），不是本專案程式碼裡可重現的系統性問題。

### 政府標案資料：已評估過的來源與結論（不要重複調查）

四條路都查過了，結論與查證日期一併記在這裡。要再動這個題目之前先讀完這一段，避免重跑同樣的調查。

| # | 來源 | 結論 |
|---|---|---|
| 1 | `pcc-api.openfun.app`（g0v 社群鏡像，原 `pcc.g0v.ronny.tw`） | **不可用**——Cloudflare managed challenge。詳見下方。實作保留在 `feat/pcc-tender-search`。 |
| 2 | `web.pcc.gov.tw` 站台一般內容（爬網頁） | **不採用**——著作權聲明的授權範圍太窄。**不是** robots.txt 的緣故。 |
| 3 | `data.gov.tw`（國家開放資料平台） | **已查證，不採用**——授權乾淨但**沒有全國性的逐筆招標／決標資料集**。 |
| 4 | `web.pcc.gov.tw` 的兩個**資料集下載頁**（`/tps/tp/OpenData/showList`、`/tps/tp/OpenData/showGPAList`） | **技術與授權都過關的部分候選**（2026-08 查證）——逐筆、持續更新、頁面明示政府資料開放授權條款第 1 版。**卡在涵蓋範圍只有全國量的個位數百分比**，見下方。 |

**結論：#1～#3 走不通；#4 是目前唯一還活著的方向，但只能回答「部分」標案，不能回答「任一」標案。** 要不要在這個限制下做，是產品決定，不是技術決定——真的要做之前先把下方「#4 的涵蓋範圍」那段讀完。

**#2 的判斷過程與結論（重要：「robots.txt 禁止」這個前提是錯的，不要再引用它）**

- **`web.pcc.gov.tw` 根本沒有 robots.txt。** 實測 `https://web.pcc.gov.tw/robots.txt` 回 **HTTP 302，轉址到 `/pis`**（即網站首頁），不是 robots 檔案。`data.gov.tw/robots.txt` 則回 **404**。依 RFC 9309，robots.txt 取不到（4xx／轉址後不是有效的 robots 內容）等同「未設限」，**不是**「禁止」。所以「因為 robots.txt 不允許所以不能做」這個論述不成立，不要再拿它當理由。
- **但仍然不採用，理由是授權範圍，不是 robots.txt。** 政府電子採購網的著作權聲明（原文逐字收在 `feat/pcc-tender-search` 的 `PCC_COPYRIGHT_NOTICE`）只允許「為**個人或家庭非營利**之目的而重製」，以及「為報導、評論、教學、研究或其他正當目的，**在合理範圍內**引用並註明出處」。本專案是**公開的 MCP 服務，對不特定第三人轉散布**，把整批標案資料鏡像下來再對外提供，既不是個人/家庭非營利重製，也很難主張是「合理範圍內的引用」。聲明本身也把大量／商業利用**明確導向另外提供的開放資料集**，而不是這個網站本身。
- **⚠️ 這個結論的適用範圍在 2026-08 被收窄了：它只涵蓋「爬站台一般網頁」，不涵蓋 #4 的兩個資料集下載頁。** 上面那段當初是讀站台頁尾的著作權聲明推出來的，而**當時沒有實際打開資料集下載頁**（見下方「未完成的查證」）。實際打開後發現，那兩頁各自在頁面上明示「授權方式: 政府資料開放授權條款-第1版」並附授權說明網址——也就是著作權聲明所說的「大量利用請走開放資料集」，指的正是這兩頁。所以對這兩頁而言，授權不是障礙；障礙是涵蓋範圍。不要再把「著作權聲明太窄」套用到 #4。
- **而那個被指向的開放資料管道已經失效。** g0v 首頁引用的 `web.pcc.gov.tw/tpsreport/transfer/dataTransfer.do?method=getOkfnOpenDataXml` 實測回 **HTTP 200 但轉址到 `/pis/` 首頁、Content-Type 是 `text/html`（257KB HTML，不是 XML）**。也就是官方自己指定的「大量利用請走這裡」入口目前拿不到東西。
- **站台對擷取工具的態度不一致，訊號不明確。** WebFetch（會遵守 robots 語意的擷取工具）對 `web.pcc.gov.tw` 一律拿到 **HTTP 403**；但從 GitHub Actions 用瀏覽器 User-Agent 的純 GET 可以拿到 200（約 4 秒）。存在應用層的 bot 過濾，但**沒有** Cloudflare challenge——這點與 #1 不同。
- ~~**未完成的查證**：`showList` 頁面實際提供的檔案格式／大小／更新頻率、以及「近半年GPA資料集下載」的實際內容與涵蓋欄位，都還沒實際取得。~~ **2026-08 已補查完成，見下方 #4。查完之後上面那條「先解授權再談格式」的判斷被推翻了——授權本來就沒問題，問題一直是涵蓋範圍。**

**#3 的查證結果：授權確實乾淨，但資料涵蓋範圍不合用——問題不在授權，在於「根本沒有那個資料集」。**

查證方式：sandbox 的 egress proxy 拒絕 `data.gov.tw`（`connect_rejected`），WebFetch 也一律拿到 **HTTP 403**，所以改從 GitHub Actions 呼叫平台自己的 REST API（`https://data.gov.tw/api/v2/rest/dataset/{id}`，回 200 + JSON）。以下每一欄都是 API 回傳的實際值，不是從資料集名稱或描述推測的：

| datasetId | 名稱 | license | updateFrequency | 格式 | 實際涵蓋範圍（API 的 description 原文） |
|---|---|---|---|---|---|
| 7260 | 公開閱覽公告 | `1` | 每 **1 日** | XML | 「提供**近一週**各機關辦理公告招標前之招標文件公開閱覽案件明細」 |
| 7261 | 公開徵求公告 | `1` | 每 **1 日** | XML | 「提供**近一週**各機關辦理公告招標前，公開徵求廠商提供參考資料之案件明細」 |
| 6573 | 優先採購招標公告 | `1` | 每 **1 日** | XML | 「提供等標期內**優先採購身心障礙福利機構產品或勞務**之招標公告資訊」 |
| 9704 | 各機關每月依採購性質之決標件數及決標金額統計 | `1` | 每 **1 月** | JSON | **統計數字**（件數／金額），不是逐筆標案 |
| 6576 | 政府電子採購網採購標的分類 | `1` | 每 **1 月** | XML | 分類**代碼對照表**，不是標案資料 |
| 8345 | 財政部年度採購案件 | `1` | 每 **1 年** | CSV | **單一機關**、一年一次 |

`license: "1"` 即政府資料開放授權條款第 1 版，`cost: "free"`——**授權面完全沒問題**，這點與 #2 相反。

**不採用的理由是涵蓋範圍：找不到「全國、逐筆、持續更新」的招標／決標資料集。** 更新頻率夠的那三筆（7260／7261／6573）全是**招標前**或**法定利基**的窄切片：公開閱覽與公開徵求都只是少數採購案才會有的前置程序，且只保留**近一週**滾動視窗（不是可查詢的歷史庫）；優先採購則限身心障礙福利機構產品／勞務。涵蓋面夠廣的那兩筆（9704／6576）不是逐筆資料。也就是說，使用者會問的「某某標案是誰得標、預算多少」，這些資料集**一筆都答不出來**。

佐證：平台上有一則公民建議「請開放政府電子採購網的各式招標公告、決標公告、無法決標公告、撤銷公告等資料查詢 API」（`data.gov.tw/suggests/88841`）——**這個 API 之所以有人要求開放，正是因為它還沒開放**。（該頁對 WebFetch 回 403，未能取得工程會的正式回覆內容。）

**查證範圍的誠實界線**：平台的關鍵字搜尋 API（`/api/v2/rest/dataset?q=`）回 **HTTP 405**，我沒有可用的搜尋端點，因此是「以網頁搜尋找出候選 id、再逐一用 API 查證」，不是窮舉工程會的全部資料集。所以正確的說法是「在查到的候選中沒有合用的」，而不是「可證明不存在」。但要找的東西（全國逐筆招標／決標）若存在會是頭條級的資料集，兩次網頁搜尋都沒出現，加上上述公民建議仍在，合理推斷它確實沒開放。

**`atmOpenData?runType=N` 這條線索已在 2026-08-03 徹底探測完畢，不要再重跑。**

9704 的下載網址是 `https://web.pcc.gov.tw/tps/openDataApi/atmOpenData?runType=7`。整個 runType 參數空間都掃過了（GitHub Actions、瀏覽器 UA，因為 sandbox 的 egress proxy 拒絕 `web.pcc.gov.tw`）：

- **端點可達，沒有被 403 擋。** `Server: Apache`，`Content-Type: application/json;charset=UTF-8`，沒有 Cloudflare challenge。（WebFetch 仍然一律 403，那是既有紀錄的應用層 bot 過濾，不是這個端點特有的。）
- **只有 runType 1～11 有內容；0 與 12～45 一律 HTTP 200 但 0 bytes**（不是 404，是空回應）。合法值也**無法從網頁列舉**——`showList` 整頁 224KB 裡 `runType=` 出現 0 次，WebSearch 也找不到任何 `atmOpenData` 的公開文件。它是未公開的內部端點。
- **11 個值裡有 10 個是統計數字**（近1季／每月的件數與金額彙總，7 就是 data.gov.tw 9704；8 回空陣列；10、11 是 GPA 彙總）。
- **只有 `runType=9` 是逐筆資料**：bare array、2,203 筆、7 個欄位（招標機關／標案案號／標案名稱／招標方式／決標日期／決標金額／得標廠商名稱，每筆都齊全）。決標日期橫跨 20170523～20260630、303 個機關。但它是**巨額工程決標的窄切片**：決標金額最小 3,000 萬、最大 607.9 億，2,128/2,203 筆 ≥ 2 億，平均一年只有約 220 筆。回答不了一般標案的問題。
- **授權：這個端點沒有任何授權依據可引用，且不可假設與 9704 一致。** `showList`、`showOpenDataList`、站台首頁三頁裡都**找不到 `atmOpenData` 或 `runType` 的字串**，也就是它根本沒有被掛在任何一個標示授權的頁面下。runType=7 之所以有「政府資料開放授權條款第 1 版」，是因為**那一筆被 data.gov.tw 收錄成資料集 9704**；runType=9 的資料在 data.gov.tw 上找不到對應資料集，所以它**沒有任何一份授權聲明涵蓋它**。要用它就得先向工程會問清楚，不能拿 9704 的授權往上套。

**「近半年GPA資料集」也找到了**：在 `https://web.pcc.gov.tw/tps/tp/OpenData/showGPAList`（從 `showOpenDataList` 頁的連結找到的，不是從 runType 找到的）。詳見下面 #4。

**#4 的查證結果（2026-08-03）：兩個資料集下載頁提供逐筆、持續更新、授權乾淨的資料——但涵蓋範圍只有全國量的個位數百分比。**

兩頁都在頁面上直接標示「**授權方式: 政府資料開放授權條款-第1版**」並附授權說明網址。這是**每一頁各自查證的**，不是從 data.gov.tw 或彼此推斷的：

| 頁面 | 檔案 | 更新規則（頁面原文） | 回溯範圍 | 實測內容 |
|---|---|---|---|---|
| `/tps/tp/OpenData/showList`（資料集下載） | `tender_YYYYMMnn.xml`（招標）、`award_YYYYMMnn.xml`（決標），半月一檔，共 270 個檔 | 「每個月 5 號會產出 2 個月前的資料，比如 10/5 會產出 8 月份的檔案」 | 回溯到 **2015/04** | `award_20260602.xml` 195 筆；17 個 XML 元素，含 `BIDDER_LIST`（得標與**未得標**廠商名稱＋地址）、`TENDER_AWARD_PRICE`、`TENDER_AWARD_WAY`、機關聯絡人與電話。`tender_20260601.xml` 352 筆、6 個元素 |
| `/tps/tp/OpenData/showGPAList`（近半年GPA資料集下載） | `GPAtender_YYYYMMnn.json`、`GPAaward_YYYYMMnn.json`，共 46 個檔（202409～202608） | 「每個月 1 及 16 號會產出前 2~7 個月前的資料」 | 滾動 **近半年**視窗 | `GPAaward_20260701.json` 2,810 筆（涵蓋 2026/01/01–06/30）、15 個欄位；`GPAtender_20260701.json` 3,582 筆、6 個欄位。**JSON，不用剖 XML** |

**擋住這條路的是涵蓋範圍，而且缺口很大：**

- GPA 那組**依定義就是窄的**：只涵蓋適用 WTO 政府採購協定的案件。用工程會自己的數字（`runType=10`，115年07月）換算，適用 GPA 案件是全部招標案件的 **3.27%（件數）／20.2%（金額）**。
- `showList` 的 XML 那組**不是 GPA 子集，也不是金額門檻**，兩者都實測排除了：與同期 `GPAaward` 的標案案號重疊只有 **6.5%／8.2%**；金額最低 359,282 元、中位數約 1,940 萬、170 筆裡有 41 筆低於 1,000 萬（若是巨額門檻不會長這樣）。
- 但它的量**同樣只有全國的約 2%**：全國每月招標約 30,616 件（同樣是 `runType=10` 自己的數字），而這裡半個月只有 352 件。
- **它到底依什麼規則取樣／篩選，頁面完全沒有說明，我也沒查出來。** 這是這次調查誠實的未解點，不要假裝知道。真的要用這個資料源，這一題必須先解——否則工具會對使用者宣稱「查不到這個標案」，但其實只是它不在那 2% 裡面，這比不提供功能更糟。

**若日後重啟，從這裡接續**：先向工程會問清楚 `showList` 那組 XML 的取樣規則（以及 `atmOpenData?runType=9` 的授權），而不是先寫程式。技術面已經沒有阻礙了。

**（架構備註，若日後真的走「定期同步靜態快照」這條路）** 這會是本專案第一個「非即時查詢」的來源，與現有 registry/adapter 的假設（每次 tool call 打一次上游）不同：需要一個排程同步（比照 `fixtures-refresh.yml`）把快照寫進儲存層，工具查的是快照而非上游。儲存層的選擇取決於量級——KV 適合「少量 key、整包讀取」，一旦需要依關鍵字/機關做逐筆查詢與篩選，KV 會退化成「把整包讀出來再在記憶體過濾」，那就該用 D1（SQLite，支援索引與 LIKE 查詢）。這個決定在拿到真實檔案大小與筆數之前不要先定。

**政府標案資料來源（`pcc-api.openfun.app`，原 `pcc.g0v.ronny.tw`）目前無法程式化存取——完整實作保留在 `feat/pcc-tender-search` 分支，待來源恢復可存取時直接接續，不要重新開發。**

- **現況**：`pcc.g0v.ronny.tw` 已搬遷，一律回 `301`，`Location`／`X-Target` 皆為 `https://pcc-api.openfun.app`——**是裸網域，不帶路徑**，跟隨轉址會把 `/api/...` 路徑與 query string 整個丟掉。新站台位於 Cloudflare **managed challenge** 之後：實測 `/api/getinfo` 與 `/api/searchbytitle`、預設 UA 與瀏覽器 UA 共四種組合，**全部回 HTTP 403 + 「Just a moment...」challenge 頁**；challenge 內的 `cUPMDTk` 欄位就是 `/api/getinfo?__cf_chl_tk=...`，證明 challenge 打在 **API 路徑本身**，不只是首頁。
- **為什麼不是「換個環境就會通」**：challenge 型別是 `cType: 'managed'`，需要執行 JavaScript 並接受 cookie。`fetch()`（含 Cloudflare Worker 內的 fetch）沒有 JS 執行環境與 cookie jar。**這與 `tisvcloud.freeway.gov.tw` 的「雲端 IP 被靜默丟包」是不同機制**——那次的解法（部署後從 Worker 出口打 debug probe）在這裡不適用，不要套用同一套結論去期待「從 Worker 打就會通」。唯一未實測的環境是本專案部署後的 Worker，基於上述機制研判結果相同。
- **不要嘗試繞過**（headless browser、challenge solver、cookie 收割等）。這是服務營運方對自己志工維運基礎設施刻意設下的存取控制，繞過它是規避他人的存取控制，不在本專案的做法範圍內。
- **已完成、保留在 `feat/pcc-tender-search` 分支上的東西**（不要重寫）：`adapters/pcc.ts`、`registry/pcc.ts`（`pcc:searchbytitle` entry）、`tools/tender.ts`（`tw_tender_search`），以及三者的完整測試。API 端點與參數已對照該服務自己的 `webdata/swagger.json` 與 `webdata/controllers/ApiController.php` 查證過：**沒有招標狀態參數**（最接近的是每筆結果的 `brief.type` 公告類型）、**沒有依機關名稱搜尋的端點**（`listbyunit` 要機關代碼，所以機關篩選只能 client-side）、**預算金額與截止投標日期不在搜尋回應裡**（需要 `columns[]`，而合法欄位名未列舉，原訂用 `/api/tender` 探測但被封鎖擋住）。著作權聲明是 著作權法 合理使用基礎的較窄授權，**不是政府資料開放授權條款第 1 版**，原文已逐字收在該分支的 `PCC_COPYRIGHT_NOTICE`。
- **恢復步驟**：確認來源可存取後，把該分支 rebase 到最新 main，在 `src/index.ts` 加回 `registerTool("tw_tender_search", ...)` 區塊，並把 `pcc` 加回 `SourceId`／`SOURCE_PROVENANCE`（值為 `community-mirror`）與 `tools/generic.ts` 的 `ADAPTERS` map 與 source enum。`SourceProvenance` 型別、envelope 的 `provenance` 欄位與 `tw_search_datasets` 的非官方標示邏輯**已經在 main 上**，不需要重做。

**shape-diff.ts 的 `shapeOf` 只檢查陣列第一筆元素的結構，這在真實世界資料波動時會造成「假陽性」的欄位增減提示。** 已至少在兩個獨立資料集上重複驗證過這個現象：`tdx:bus-eta` 的 `EstimateTime`（有/無公車即時預估，純粹取決於抓取當下路線上是否真的有車在跑）與 `cwa:W-C0034-005` 的 `MovingPrediction`（取決於當下第一筆 `Fix` 記錄是否恰好帶有移動預測文字）都曾經在不同次 dispatch 之間互相「新增」又「移除」，但欄位本身在程式碼裡本來就是（且應該維持）optional，不是真的 schema 變動。**規範**：(1) 任何依賴這類欄位的測試，斷言用的樣本資料必須手寫（引用真實欄位值即可）而非依賴 fixture 陣列的固定位置索引（例如 `fixture[0]`），否則下一次 fixture 被真實資料重新整理時測試會脆弱地壞掉——這正是 tw_rail 那次 delay-notice 修復連帶發現、修掉的問題；(2) 看到這類欄位在 schema-drift PR 裡「新增」或「移除」時，先確認程式碼是否已經把它當 optional 處理，若是，只需要更新 fixture 本身，不需要當作真正的結構變動去修 transform。

## 7. What a PR must say

1. **Files touched**, grouped by layer (infra / adapters / registry / tools / docs).
2. **New registry entries added**, if any (id, dataset, source).
3. **Any deviation from `docs/ARCHITECTURE.md`** — new interface fields, different error-code mapping than an obvious reading of the doc would suggest, anything left deliberately unimplemented (e.g. `issuedAt` unset because no dataset in this server has an unambiguous single "as of" timestamp yet).
4. **Test count before/after**, and what the new tests cover.
5. For a pure refactor (no behavior change intended): an explicit statement of what, if anything, differs in the tool's *external* behavior (response shape, error text, timing) — even things that seem like harmless improvements (e.g. adding a request timeout that didn't exist before) should be called out, not left for the reviewer to discover.
