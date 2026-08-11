import {
  OPEN_METEO_FORECAST_BASE_URL,
  OPEN_METEO_GEOCODING_BASE_URL,
  OPEN_METEO_TERMS_URL
} from "../constants.js";
import { ToolError } from "../infra/errors.js";
import { httpGet, isTimeoutError } from "../infra/http.js";
import type { Env } from "../index.js";
import type { DatasetEntry } from "../registry/index.js";
import type { SourceAdapter } from "./types.js";

/**
 * Open-Meteo adapter — the second keyless source in this project (after
 * `highway`) and the first whose endpoints span TWO hosts: the forecast API
 * is on `api.open-meteo.com`, geocoding on `geocoding-api.open-meteo.com`
 * (both confirmed by real calls, see constants.ts).
 *
 * Host selection is a per-entry lookup here rather than a new
 * `DatasetEntry` field: URL assembly is explicitly the adapter's
 * responsibility (AGENTS.md §1), and which hostname serves a given endpoint
 * is knowledge about this upstream, not about the dataset. Keeping it here
 * means no fourth documented extension to the shared `DatasetEntry`
 * interface for something only one source needs.
 */
const BASE_URL_BY_ENTRY_ID: Record<string, string> = {
  "openmeteo:forecast": OPEN_METEO_FORECAST_BASE_URL,
  "openmeteo:geocoding": OPEN_METEO_GEOCODING_BASE_URL
};

/**
 * Open-Meteo's documented error shape, confirmed against the real API for
 * four independent bad requests (missing longitude, latitude out of range,
 * unknown variable name, non-numeric latitude): every one returned HTTP 400
 * with a JSON body `{"error": true, "reason": "..."}`. Key order varies
 * between responses, so this is matched structurally, never positionally.
 */
interface OpenMeteoErrorBody {
  error?: boolean;
  reason?: string;
}

function extractUpstreamReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const candidate = body as OpenMeteoErrorBody;
  return typeof candidate.reason === "string" && candidate.reason.length > 0 ? candidate.reason : null;
}

/**
 * Builds the exact request URL the adapter sends upstream. Exported for the
 * same reason as `buildCwaUrl`/`buildMoenvUrl`/`buildTdxUrl`/
 * `buildHighwayUrl`: one place assembles the real URL, so tests and
 * scripts/fixtures/refresh-fixtures.ts can't drift from production.
 */
export function buildOpenMeteoUrl<TParams, TRaw>(
  entry: DatasetEntry<TParams, TRaw, unknown>,
  params: TParams
): URL {
  const base = BASE_URL_BY_ENTRY_ID[entry.id];
  if (base === undefined) {
    // Registering an openmeteo entry without adding it above would
    // otherwise produce a URL like "undefined/forecast" and a confusing
    // network error — fail loudly at the seam instead.
    throw new ToolError({
      code: "SCHEMA_MISMATCH",
      message: `Open-Meteo 資料集「${entry.id}」沒有對應的 API 主機設定，這是本伺服器的設定疏漏，請回報。`
    });
  }
  const url = new URL(`${base}/${entry.path}`);
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
  const url = buildOpenMeteoUrl(entry, params);

  let response: Response;
  try {
    response = await httpGet(url.toString(), { headers: { accept: "application/json" } }, fetchImpl);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ToolError({
        code: "UPSTREAM_TIMEOUT",
        message: "Open-Meteo API 連線逾時（5 秒）。請稍後再試；若持續發生，該服務可能忙碌或維護中。"
      });
    }
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `無法連線到 Open-Meteo API：${error instanceof Error ? error.message : String(error)}。請稍後再試。`
    });
  }

  // Read the body once, up front: Open-Meteo puts its machine-readable
  // failure reason in the BODY of a 400, so a status-only check would throw
  // away the one piece of information that tells a caller what to fix.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const reason = extractUpstreamReason(body);
    // 429 is the free tier's documented rate-limit signal (10,000/day,
    // 5,000/hour, 600/minute). Distinguished from a generic upstream error
    // because the caller's remedy is completely different — wait, or move
    // to a paid plan — and because conflating a quota problem with a broken
    // endpoint is exactly the confusion AGENTS.md §6 records for TDX's 429.
    if (response.status === 429) {
      throw new ToolError({
        code: "UPSTREAM_ERROR",
        message:
          "Open-Meteo API 回報超出免費方案的呼叫額度（HTTP 429）。" +
          (reason ? `上游訊息：${reason}。` : "") +
          `免費方案限制為每日 10,000 次、每小時 5,000 次、每分鐘 600 次（見 ${OPEN_METEO_TERMS_URL}）。`,
        hint: "請稍後再試。若這個伺服器的查詢量長期超過免費額度，需要改為自架並向 Open-Meteo 訂閱付費方案。"
      });
    }
    throw new ToolError({
      code: response.status === 400 ? "INVALID_PARAMS" : "UPSTREAM_ERROR",
      message:
        `Open-Meteo API 回應錯誤（HTTP ${response.status}）` +
        // Relayed verbatim: unlike CWA/MOENV (whose error text can echo the
        // API key back — see those adapters' redaction), Open-Meteo needs no
        // credential at all, so there is nothing in this string to redact.
        (reason ? `：${reason}` : "。")
    });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ToolError({
      code: "SCHEMA_MISMATCH",
      message: "Open-Meteo API 回應不是預期的 JSON 物件，可能是端點路徑錯誤或該服務回傳了非預期的內容。"
    });
  }

  // Open-Meteo also signals some failures with HTTP 200 + `{"error": true,
  // ...}` in principle; treat an explicit error flag as a failure regardless
  // of status rather than handing a caller a body with no usable data.
  if ((body as OpenMeteoErrorBody).error === true) {
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `Open-Meteo API 回報錯誤：${extractUpstreamReason(body) ?? "（上游未提供原因）"}`
    });
  }

  return body as TRaw;
}

export const openMeteoAdapter: SourceAdapter = {
  id: "openmeteo",
  // Not a government agency — the displayName says so plainly, because this
  // string is what lands in the envelope's `source` and in
  // tw_search_datasets' listing, where every other value is a ministry.
  displayName: "Open-Meteo（非官方第三方氣象資料服務）",
  fetchDataset
};
