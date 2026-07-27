import { PCC_API_BASE_URL, PCC_OFFICIAL_SITE_URL } from "../constants.js";
import { ToolError } from "../infra/errors.js";
import { httpGetWithBody, isTimeoutError } from "../infra/http.js";
import type { Env } from "../index.js";
import type { DatasetEntry } from "../registry/index.js";
import type { SourceAdapter } from "./types.js";

/**
 * 政府標案公告 — g0v 社群維護的非官方鏡像（pcc.g0v.ronny.tw）。
 *
 * **This is the only non-official source in this project** (see
 * `SOURCE_PROVENANCE` in registry/index.ts). It re-publishes 政府電子採購網's
 * announcements; it is not the 行政院公共工程委員會 speaking. The adapter
 * layer stays neutral about that — surfacing the caveat to callers is
 * `tools/tender.ts`'s job — but it matters here for two concrete reasons:
 *
 * 1. **No auth.** Like `adapters/highway.ts` and unlike CWA/MOENV/TDX,
 *    there is no key to inject, so there is no `AUTH_MISSING` path at all.
 * 2. **Volunteer-run infrastructure.** The upstream PHP
 *    (openfunltd/pcc.g0v.ronny.tw, `webdata/controllers/ApiController.php`)
 *    calls `OpenFunAPIHelper::checkUsage()` on every API action — a usage-
 *    metering hook whose thresholds are not published anywhere. We can't
 *    verify how close a caller is to any limit, so this adapter is
 *    deliberately a light client: one request per tool call, a long cache
 *    TTL upstream of it (`TENDER_SEARCH_CACHE_TTL_SECONDS`), and no
 *    fan-out/pagination-walking.
 *
 * Everything about the request shape below was verified against that repo's
 * own OpenAPI spec (`webdata/swagger.json`) and PHP implementation, because
 * the live host is unreachable from this sandbox — the egress proxy denies
 * the domain at CONNECT, so neither WebFetch nor curl can reach it. That is
 * the same situation as `tisvcloud.freeway.gov.tw` (AGENTS.md §6) and calls
 * for the same remedy: verify the real response shape by probing from the
 * deployed Worker, not by trusting this skeleton.
 */

/**
 * Builds the exact request URL the adapter sends upstream. Exported for
 * symmetry with `buildCwaUrl`/`buildMoenvUrl`/`buildTdxUrl`/`buildHighwayUrl`
 * — a single place that assembles the real request URL, usable by tests
 * without duplicating the logic.
 */
export function buildPccUrl<TParams, TRaw>(
  entry: DatasetEntry<TParams, TRaw, unknown>,
  params: TParams
): URL {
  const url = new URL(`${PCC_API_BASE_URL}/${entry.path}`);
  for (const [key, value] of Object.entries(entry.buildQueryParams(params))) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

async function fetchDataset<TParams, TRaw>(
  entry: DatasetEntry<TParams, TRaw, unknown>,
  params: TParams,
  _env: Env,
  fetchImpl: typeof fetch = fetch
): Promise<TRaw> {
  const url = buildPccUrl(entry, params);

  // `httpGetWithBody` (not plain `httpGet`) so the timeout budget covers
  // downloading the body too, not just time-to-headers: this endpoint
  // returns a fixed 100 records per page (hardcoded upstream), each
  // carrying a nested `brief` object, so the body is substantially larger
  // than the city/station-scoped JSON that CWA/MOENV/TDX return.
  //
  // `timeoutMs: 9000` rather than the infra default of 5000. Unlike
  // adapters/highway.ts — whose 9000 is backed by real production
  // measurement — this number is NOT yet evidence-based: this host has
  // never been reached from anywhere in this project, so its real latency
  // distribution is unknown. 9000 is the deliberately cautious starting
  // point for a volunteer-run service doing an Elasticsearch query per
  // request, and should be revisited against real numbers once the
  // deployed Worker has measured it, exactly as highway's was.
  let response: Response;
  let rawBody: string;
  try {
    ({ response, body: rawBody } = await httpGetWithBody(
      url.toString(),
      r => (r.ok ? r.text() : Promise.resolve("")),
      { headers: { accept: "application/json" }, timeoutMs: 9000 },
      fetchImpl
    ));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ToolError({
        code: "UPSTREAM_TIMEOUT",
        message:
          "連線至 g0v 標案資料鏡像服務（pcc.g0v.ronny.tw）逾時（含下載回應內容，共 9 秒）。" +
          `這是社群志工維護的服務，可能暫時忙碌或維護中，請稍後再試；如需即時且權威的資料，請直接查詢政府電子採購網（${PCC_OFFICIAL_SITE_URL}）。`
      });
    }
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message:
        `無法連線到 g0v 標案資料鏡像服務（pcc.g0v.ronny.tw）：${error instanceof Error ? error.message : String(error)}。` +
        `請稍後再試；如需即時且權威的資料，請直接查詢政府電子採購網（${PCC_OFFICIAL_SITE_URL}）。`
    });
  }

  if (!response.ok) {
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message:
        `g0v 標案資料鏡像服務（pcc.g0v.ronny.tw）回應錯誤（HTTP ${response.status}）。` +
        `請稍後再試；正式資料請以政府電子採購網（${PCC_OFFICIAL_SITE_URL}）為準。`
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: "g0v 標案資料鏡像服務回傳了無法解析的內容，可能是暫時性服務異常，請稍後再試。"
    });
  }

  // Fail-loud on a genuinely broken payload, but don't assume a specific
  // envelope shape beyond "an object" — same reasoning as adapters/tdx.ts's
  // relaxed check. This service's endpoints don't share one uniform
  // wrapper: `/api/searchbytitle` and `/api/listbyunit` return
  // `{records: [...]}` with *differently named* pagination fields
  // (`total_records`/`total_pages` vs `total`/`total_page`), and
  // `/api/unit` returns a bare id→name map with no `records` at all.
  // Validating any one of those here would hard-code one endpoint's shape
  // into the adapter, which is the registry transform's job instead.
  if (parsed === null || typeof parsed !== "object") {
    throw new ToolError({
      code: "SCHEMA_MISMATCH",
      message: "g0v 標案資料鏡像服務回傳的內容不是預期的 JSON 物件，可能是服務異常或 API 格式已變更。"
    });
  }

  return parsed as TRaw;
}

export const pccAdapter: SourceAdapter = {
  id: "pcc",
  // Deliberately names the mirror AND the original publisher: this string
  // becomes the envelope's `source`, and "政府電子採購網" alone would imply
  // the government served this response.
  displayName: "g0v 標案資料鏡像（資料源自政府電子採購網）",
  fetchDataset
};
