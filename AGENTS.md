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

**shape-diff.ts 的 `shapeOf` 只檢查陣列第一筆元素的結構，這在真實世界資料波動時會造成「假陽性」的欄位增減提示。** 已至少在兩個獨立資料集上重複驗證過這個現象：`tdx:bus-eta` 的 `EstimateTime`（有/無公車即時預估，純粹取決於抓取當下路線上是否真的有車在跑）與 `cwa:W-C0034-005` 的 `MovingPrediction`（取決於當下第一筆 `Fix` 記錄是否恰好帶有移動預測文字）都曾經在不同次 dispatch 之間互相「新增」又「移除」，但欄位本身在程式碼裡本來就是（且應該維持）optional，不是真的 schema 變動。**規範**：(1) 任何依賴這類欄位的測試，斷言用的樣本資料必須手寫（引用真實欄位值即可）而非依賴 fixture 陣列的固定位置索引（例如 `fixture[0]`），否則下一次 fixture 被真實資料重新整理時測試會脆弱地壞掉——這正是 tw_rail 那次 delay-notice 修復連帶發現、修掉的問題；(2) 看到這類欄位在 schema-drift PR 裡「新增」或「移除」時，先確認程式碼是否已經把它當 optional 處理，若是，只需要更新 fixture 本身，不需要當作真正的結構變動去修 transform。

## 7. What a PR must say

1. **Files touched**, grouped by layer (infra / adapters / registry / tools / docs).
2. **New registry entries added**, if any (id, dataset, source).
3. **Any deviation from `docs/ARCHITECTURE.md`** — new interface fields, different error-code mapping than an obvious reading of the doc would suggest, anything left deliberately unimplemented (e.g. `issuedAt` unset because no dataset in this server has an unambiguous single "as of" timestamp yet).
4. **Test count before/after**, and what the new tests cover.
5. For a pure refactor (no behavior change intended): an explicit statement of what, if anything, differs in the tool's *external* behavior (response shape, error text, timing) — even things that seem like harmless improvements (e.g. adding a request timeout that didn't exist before) should be called out, not left for the reviewer to discover.
