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

  // TEMPORARY DEBUG LOGGING — remove once the "回應中缺少 records 欄位" issue
  // reported against tw_air_quality is root-caused. api_key is masked to its
  // first 4 characters before logging.
  const maskedUrl = new URL(url.toString());
  const rawKey = maskedUrl.searchParams.get("api_key") ?? "";
  maskedUrl.searchParams.set("api_key", rawKey.length > 4 ? `${rawKey.slice(0, 4)}***` : "***");
  console.log(`[moenv-client] request url: ${maskedUrl.toString()}`);

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

  console.log(`[moenv-client] response status: ${response.status}`);

  const rawBody = await response.text();
  console.log(`[moenv-client] response body (first 500 chars): ${rawBody.slice(0, 500)}`);

  if (response.status === 401 || response.status === 403) {
    throw new OpenDataApiError(invalidKeyMessage(`HTTP ${response.status}`));
  }
  if (!response.ok) {
    throw new OpenDataApiError(`環境部開放資料平臺回應錯誤（HTTP ${response.status}）。請稍後再試。`);
  }

  let payload: MoenvApiEnvelope<TRecord>;
  try {
    payload = JSON.parse(rawBody) as MoenvApiEnvelope<TRecord>;
  } catch {
    throw new OpenDataApiError("環境部開放資料平臺回傳了無法解析的內容，可能是暫時性服務異常，請稍後再試。");
  }

  if (!payload.records) {
    const message = payload.message ?? "";
    if (/api[_-]?key|not valid|invalid|授權|金鑰/i.test(message)) {
      throw new OpenDataApiError(invalidKeyMessage(message));
    }
    throw new OpenDataApiError(`環境部開放資料平臺回傳失敗：${message || "回應中缺少 records 欄位"}。`);
  }

  return payload.records;
}
