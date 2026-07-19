import { CWA_API_BASE_URL, CWA_AUTH_KEY_URL } from "../constants.js";
import { OpenDataApiError } from "./errors.js";
import type { CwaApiEnvelope } from "../types.js";

/** Raised for any CWA request failure; `.message` is safe to show directly to an LLM/user. */
export class CwaApiError extends OpenDataApiError {
  constructor(message: string) {
    super(message);
    this.name = "CwaApiError";
  }
}

const MISSING_KEY_MESSAGE =
  `尚未設定中央氣象署開放資料 API 金鑰（CWA_API_KEY）。` +
  `請至 ${CWA_AUTH_KEY_URL} 免費申請會員與授權碼，` +
  `並在 Cloudflare Workers 執行 \`wrangler secret put CWA_API_KEY\` 設定後再試一次。`;

function invalidKeyMessage(detail?: string): string {
  return (
    `中央氣象署 API 金鑰無效或已過期${detail ? `（${detail}）` : ""}。` +
    `請至 ${CWA_AUTH_KEY_URL} 確認或重新申請授權碼，並更新 Workers 的 CWA_API_KEY secret。`
  );
}

/**
 * Fetches a dataset from the CWA Open Data Platform REST API and returns its
 * `records` payload. Throws `CwaApiError` with an actionable message for
 * every failure mode (missing key, invalid key, network error, malformed
 * response) so tool handlers can surface it directly to the caller.
 */
export async function fetchCwaRecords<TRecords>(
  datasetId: string,
  apiKey: string | undefined,
  searchParams: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch
): Promise<TRecords> {
  if (!apiKey) {
    throw new CwaApiError(MISSING_KEY_MESSAGE);
  }

  const url = new URL(`${CWA_API_BASE_URL}/${datasetId}`);
  url.searchParams.set("Authorization", apiKey);
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
    throw new CwaApiError(
      `無法連線到中央氣象署開放資料平臺：${error instanceof Error ? error.message : String(error)}。請稍後再試。`
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new CwaApiError(invalidKeyMessage(`HTTP ${response.status}`));
  }
  if (!response.ok) {
    throw new CwaApiError(`中央氣象署開放資料平臺回應錯誤（HTTP ${response.status}）。請稍後再試。`);
  }

  let payload: CwaApiEnvelope<TRecords>;
  try {
    payload = (await response.json()) as CwaApiEnvelope<TRecords>;
  } catch {
    throw new CwaApiError("中央氣象署開放資料平臺回傳了無法解析的內容，可能是暫時性服務異常，請稍後再試。");
  }

  if (payload.success !== "true") {
    const message = payload.message ?? "";
    if (/auth|key|授權|金鑰/i.test(message)) {
      throw new CwaApiError(invalidKeyMessage(message));
    }
    throw new CwaApiError(`中央氣象署開放資料平臺回傳失敗：${message || "未知錯誤"}。`);
  }
  if (!payload.records) {
    throw new CwaApiError("中央氣象署開放資料平臺回應中缺少 records 欄位，可能是資料集代碼錯誤或暫時無資料。");
  }

  return payload.records;
}
