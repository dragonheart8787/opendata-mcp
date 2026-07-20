import { CWA_API_BASE_URL, CWA_AUTH_KEY_URL } from "../constants.js";
import { ToolError } from "../infra/errors.js";
import { httpGet, isTimeoutError } from "../infra/http.js";
import type { Env } from "../index.js";
import type { DatasetEntry } from "../registry/index.js";
import type { CwaApiEnvelope } from "../types.js";
import type { SourceAdapter } from "./types.js";

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

async function fetchDataset<TParams, TRaw>(
  entry: DatasetEntry<TParams, TRaw, unknown>,
  params: TParams,
  env: Env,
  fetchImpl: typeof fetch = fetch
): Promise<TRaw> {
  const apiKey = env.CWA_API_KEY;
  if (!apiKey) {
    throw new ToolError({ code: "AUTH_MISSING", message: MISSING_KEY_MESSAGE });
  }

  const url = new URL(`${CWA_API_BASE_URL}/${entry.path}`);
  url.searchParams.set("Authorization", apiKey);
  url.searchParams.set("format", "JSON");
  for (const [key, value] of Object.entries(entry.buildQueryParams(params))) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  let response: Response;
  try {
    response = await httpGet(url.toString(), { headers: { accept: "application/json" } }, fetchImpl);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ToolError({
        code: "UPSTREAM_TIMEOUT",
        message: "中央氣象署開放資料平臺連線逾時（5 秒）。請稍後再試；若持續發生，官方平台可能忙碌或維護中。"
      });
    }
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `無法連線到中央氣象署開放資料平臺：${error instanceof Error ? error.message : String(error)}。請稍後再試。`
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw new ToolError({ code: "AUTH_MISSING", message: invalidKeyMessage(`HTTP ${response.status}`) });
  }
  if (!response.ok) {
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `中央氣象署開放資料平臺回應錯誤（HTTP ${response.status}）。請稍後再試。`
    });
  }

  let payload: CwaApiEnvelope<TRaw>;
  try {
    payload = (await response.json()) as CwaApiEnvelope<TRaw>;
  } catch {
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: "中央氣象署開放資料平臺回傳了無法解析的內容，可能是暫時性服務異常，請稍後再試。"
    });
  }

  if (payload.success !== "true") {
    const message = payload.message ?? "";
    if (/auth|key|授權|金鑰/i.test(message)) {
      throw new ToolError({ code: "AUTH_MISSING", message: invalidKeyMessage(message) });
    }
    throw new ToolError({ code: "UPSTREAM_ERROR", message: `中央氣象署開放資料平臺回傳失敗：${message || "未知錯誤"}。` });
  }
  if (!payload.records) {
    throw new ToolError({
      code: "SCHEMA_MISMATCH",
      message: "中央氣象署開放資料平臺回應中缺少 records 欄位，可能是資料集代碼錯誤或暫時無資料。"
    });
  }

  return payload.records;
}

export const cwaAdapter: SourceAdapter = {
  id: "cwa",
  displayName: "中央氣象署",
  fetchDataset
};
