import { MOENV_API_BASE_URL, MOENV_SIGNUP_URL } from "../constants.js";
import { ToolError } from "../infra/errors.js";
import { httpGet, isTimeoutError, redactSecret } from "../infra/http.js";
import type { Env } from "../index.js";
import type { DatasetEntry } from "../registry/index.js";
import type { MoenvApiEnvelope } from "../types.js";
import type { SourceAdapter } from "./types.js";

const MISSING_KEY_MESSAGE =
  `尚未設定環境部開放資料 API 金鑰（MOENV_API_KEY）。` +
  `請至 ${MOENV_SIGNUP_URL} 免費註冊會員並於會員專區取得 API KEY，` +
  `再於 Cloudflare Workers 執行 \`wrangler secret put MOENV_API_KEY\` 設定後重試。`;

function invalidKeyMessage(detail?: string): string {
  return (
    `環境部開放資料 API 金鑰無效或已過期${detail ? `（${detail}）` : ""}。` +
    `請至 ${MOENV_SIGNUP_URL} 的會員專區確認你的 API KEY，並更新 Workers 的 MOENV_API_KEY secret。`
  );
}

function maskApiKey(url: URL): string {
  const masked = new URL(url.toString());
  const rawKey = masked.searchParams.get("api_key") ?? "";
  masked.searchParams.set("api_key", rawKey.length > 4 ? `${rawKey.slice(0, 4)}***` : "***");
  return masked.toString();
}

/**
 * Logs request/response context to help diagnose upstream failures, without
 * spamming Cloudflare Logs (or leaking response bodies) on the normal,
 * successful path — only called right before this module throws.
 */
function logFailureContext(url: URL, status: number | "n/a", rawBody: string): void {
  console.error(
    `[moenv-adapter] request failed — url: ${maskApiKey(url)} | status: ${status} | ` +
      `body (first 500 chars): ${rawBody.slice(0, 500)}`
  );
}

/**
 * MOENV's v2 API (data.moenv.gov.tw/api/v2) returns a bare JSON array of
 * records for this dataset — there is no `{ records: [...] }` wrapper like
 * CWA uses. Some other MOENV datasets/error responses *are* wrapped objects
 * (e.g. `{ message: "..." }` on an invalid key), so this accepts either
 * shape: a top-level array, an object with a `records` array, or — as a
 * last resort — an object whose first array-of-objects property looks like
 * a record list.
 */
function extractRecordsArray<TRecord>(parsed: unknown): TRecord[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed as TRecord[];
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.records)) {
      return obj.records as TRecord[];
    }
    for (const value of Object.values(obj)) {
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
        return value as TRecord[];
      }
    }
  }
  return undefined;
}

const MISSING_VALUE_MARKERS = new Set(["", "-", "ND"]);

/**
 * MOENV's missing-value normalization, generalized across every string
 * field of a record: "", "-", and "ND" all mean "no data" and become
 * `null`. Previously this was checked ad hoc per numeric field inside the
 * air-quality tool (`toNumberOrNull`); the architecture doc calls this out
 * as an ADAPTER responsibility (a source-specific quirk, not dataset-
 * specific shaping), so it now runs here, generically, before a record
 * ever reaches a transform.
 */
export function normalizeMoenvRecord<T extends Record<string, unknown>>(
  record: T
): { [K in keyof T]: T[K] extends string ? string | null : T[K] } {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    normalized[key] = typeof value === "string" && MISSING_VALUE_MARKERS.has(value) ? null : value;
  }
  return normalized as { [K in keyof T]: T[K] extends string ? string | null : T[K] };
}

/**
 * Builds the exact request URL the adapter sends upstream (auth + format +
 * dataset-specific query params). Exported so the fixtures-refresh script
 * (scripts/fixtures/refresh-fixtures.ts) can fetch the same raw response a
 * production request would get, without duplicating auth-injection logic.
 */
export function buildMoenvUrl<TParams, TRaw>(entry: DatasetEntry<TParams, TRaw, unknown>, params: TParams, apiKey: string): URL {
  const url = new URL(`${MOENV_API_BASE_URL}/${entry.path}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "JSON");
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
  env: Env,
  fetchImpl: typeof fetch = fetch
): Promise<TRaw> {
  const apiKey = env.MOENV_API_KEY;
  if (!apiKey) {
    throw new ToolError({ code: "AUTH_MISSING", message: MISSING_KEY_MESSAGE });
  }

  const url = buildMoenvUrl(entry, params, apiKey);

  let response: Response;
  try {
    response = await httpGet(url.toString(), { headers: { accept: "application/json" } }, fetchImpl);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ToolError({
        code: "UPSTREAM_TIMEOUT",
        message: "環境部開放資料平臺連線逾時（5 秒）。請稍後再試；若持續發生，官方平台可能忙碌或維護中。"
      });
    }
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `無法連線到環境部開放資料平臺：${redactSecret(error instanceof Error ? error.message : String(error), apiKey)}。請稍後再試。`
    });
  }

  if (response.status === 401 || response.status === 403) {
    logFailureContext(url, response.status, await response.text());
    throw new ToolError({ code: "AUTH_MISSING", message: invalidKeyMessage(`HTTP ${response.status}`) });
  }
  if (!response.ok) {
    logFailureContext(url, response.status, await response.text());
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `環境部開放資料平臺回應錯誤（HTTP ${response.status}）。請稍後再試。`
    });
  }

  const rawBody = await response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    logFailureContext(url, response.status, rawBody);
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: "環境部開放資料平臺回傳了無法解析的內容，可能是暫時性服務異常，請稍後再試。"
    });
  }

  const records = extractRecordsArray<Record<string, unknown>>(parsed);
  if (!records) {
    logFailureContext(url, response.status, rawBody);
    const envelope = parsed as MoenvApiEnvelope<unknown>;
    // Defense-in-depth: this is MOENV's own error text, not something we
    // constructed — redact the caller's key from it before it can ever
    // reach a user-facing message, in case MOENV's own response ever
    // echoed it back (see redactSecret's doc comment).
    const message = redactSecret(envelope?.message ?? "", apiKey);
    if (/api[_-]?key|not valid|invalid|授權|金鑰/i.test(message)) {
      throw new ToolError({ code: "AUTH_MISSING", message: invalidKeyMessage(message) });
    }
    throw new ToolError({
      code: "SCHEMA_MISMATCH",
      message: `環境部開放資料平臺回傳失敗：${message || "回應格式不符，找不到記錄陣列"}。`
    });
  }

  return records.map(normalizeMoenvRecord) as unknown as TRaw;
}

export const moenvAdapter: SourceAdapter = {
  id: "moenv",
  displayName: "環境部",
  fetchDataset
};
