import { MOENV_API_BASE_URL, MOENV_SIGNUP_URL } from "../constants.js";
import { OpenDataApiError } from "./errors.js";
import type { MoenvApiEnvelope } from "../types.js";

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
    `[moenv-client] request failed — url: ${maskApiKey(url)} | status: ${status} | ` +
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

/**
 * Fetches records from the MOENV open data platform (data.moenv.gov.tw).
 * Unlike CWA, MOENV authenticates via an `api_key` URL query parameter.
 * Throws `OpenDataApiError` with actionable, user-facing messages.
 */
export async function fetchMoenvRecords<TRecord>(
  datasetId: string,
  apiKey: string | undefined,
  searchParams: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch
): Promise<TRecord[]> {
  if (!apiKey) {
    throw new OpenDataApiError(MISSING_KEY_MESSAGE);
  }

  const url = new URL(`${MOENV_API_BASE_URL}/${datasetId}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "JSON");
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { accept: "application/json" }
    });
  } catch (error) {
    throw new OpenDataApiError(
      `無法連線到環境部開放資料平臺：${error instanceof Error ? error.message : String(error)}。請稍後再試。`
    );
  }

  if (response.status === 401 || response.status === 403) {
    logFailureContext(url, response.status, await response.text());
    throw new OpenDataApiError(invalidKeyMessage(`HTTP ${response.status}`));
  }
  if (!response.ok) {
    logFailureContext(url, response.status, await response.text());
    throw new OpenDataApiError(`環境部開放資料平臺回應錯誤（HTTP ${response.status}）。請稍後再試。`);
  }

  const rawBody = await response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    logFailureContext(url, response.status, rawBody);
    throw new OpenDataApiError("環境部開放資料平臺回傳了無法解析的內容，可能是暫時性服務異常，請稍後再試。");
  }

  const records = extractRecordsArray<TRecord>(parsed);
  if (records) {
    return records;
  }

  logFailureContext(url, response.status, rawBody);
  const envelope = parsed as MoenvApiEnvelope<TRecord>;
  const message = envelope?.message ?? "";
  if (/api[_-]?key|not valid|invalid|授權|金鑰/i.test(message)) {
    throw new OpenDataApiError(invalidKeyMessage(message));
  }
  throw new OpenDataApiError(`環境部開放資料平臺回傳失敗：${message || "回應格式不符，找不到記錄陣列"}。`);
}
