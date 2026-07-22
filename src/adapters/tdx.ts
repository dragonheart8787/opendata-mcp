import { KV_MIN_TTL_SECONDS, TDX_API_BASE_URL, TDX_SIGNUP_URL, TDX_TOKEN_EXPIRY_BUFFER_SECONDS, TDX_TOKEN_URL } from "../constants.js";
import { ToolError } from "../infra/errors.js";
import { httpGet, httpPost, isTimeoutError } from "../infra/http.js";
import type { Env } from "../index.js";
import type { DatasetEntry } from "../registry/index.js";
import type { SourceAdapter } from "./types.js";

const MISSING_CREDENTIALS_MESSAGE =
  `尚未設定 TDX 運輸資料流通服務的 OAuth2 用戶端憑證（TDX_CLIENT_ID / TDX_CLIENT_SECRET）。` +
  `請至 ${TDX_SIGNUP_URL} 註冊會員並於會員中心建立應用程式取得 Client Id 與 Client Secret，` +
  `並在 Cloudflare Workers 執行 \`wrangler secret put TDX_CLIENT_ID\` 與 \`wrangler secret put TDX_CLIENT_SECRET\` 設定後再試一次。`;

function invalidCredentialsMessage(detail?: string): string {
  return (
    `TDX 用戶端憑證無效或已被拒絕${detail ? `（${detail}）` : ""}。` +
    `請至 ${TDX_SIGNUP_URL} 確認 Client Id / Client Secret，並更新 Workers 的 TDX_CLIENT_ID / TDX_CLIENT_SECRET secrets。`
  );
}

/** KV key the access token is cached under — same CACHE store as response caching, different key namespace (see Env's doc comment in index.ts). */
const TOKEN_CACHE_KEY = "tdx:access_token";

interface TdxTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * Requests a brand-new access token from TDX's OAuth2 client_credentials
 * endpoint. Never reads or writes the token cache itself — that's
 * `getAccessToken`'s job — so this stays a pure "ask upstream for a token"
 * function, testable in isolation.
 */
async function requestNewToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch
): Promise<{ accessToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  }).toString();

  let response: Response;
  try {
    response = await httpPost(
      TDX_TOKEN_URL,
      { headers: { "content-type": "application/x-www-form-urlencoded" }, body },
      fetchImpl
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ToolError({
        code: "UPSTREAM_TIMEOUT",
        message: "TDX 認證伺服器連線逾時（5 秒）。請稍後再試；若持續發生，官方平台可能忙碌或維護中。"
      });
    }
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `無法連線到 TDX 認證伺服器：${error instanceof Error ? error.message : String(error)}。請稍後再試。`
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw new ToolError({ code: "AUTH_MISSING", message: invalidCredentialsMessage(`HTTP ${response.status}`) });
  }
  if (!response.ok) {
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `TDX 認證伺服器回應錯誤（HTTP ${response.status}）。請稍後再試。`
    });
  }

  let payload: TdxTokenResponse;
  try {
    payload = (await response.json()) as TdxTokenResponse;
  } catch {
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: "TDX 認證伺服器回傳了無法解析的內容，可能是暫時性服務異常，請稍後再試。"
    });
  }

  if (!payload.access_token || typeof payload.expires_in !== "number") {
    throw new ToolError({
      code: "SCHEMA_MISMATCH",
      message: "TDX 認證伺服器回應中缺少 access_token 或 expires_in 欄位。"
    });
  }

  return { accessToken: payload.access_token, expiresIn: payload.expires_in };
}

/**
 * Returns a usable access token, preferring the cached one. `forceRefresh`
 * skips the cache read entirely — used by `fetchDataset` after a 401, since
 * a cached-but-rejected token must not be re-read on the retry attempt.
 *
 * Token TTL in the cache is `expires_in - TDX_TOKEN_EXPIRY_BUFFER_SECONDS`,
 * clamped to Cloudflare KV's minimum TTL (`KV_MIN_TTL_SECONDS`) so a short
 * `expires_in` (unexpected, but not something to trust blindly) can't make
 * the `put` call itself fail.
 */
export async function getAccessToken(
  env: Pick<Env, "TDX_CLIENT_ID" | "TDX_CLIENT_SECRET" | "CACHE">,
  fetchImpl: typeof fetch,
  forceRefresh = false
): Promise<string> {
  const clientId = env.TDX_CLIENT_ID;
  const clientSecret = env.TDX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ToolError({ code: "AUTH_MISSING", message: MISSING_CREDENTIALS_MESSAGE });
  }

  if (!forceRefresh && env.CACHE) {
    try {
      const cached = await env.CACHE.get(TOKEN_CACHE_KEY, "text");
      if (cached) {
        return cached;
      }
    } catch {
      // fall through to requesting a new token
    }
  }

  const { accessToken, expiresIn } = await requestNewToken(clientId, clientSecret, fetchImpl);

  if (env.CACHE) {
    const ttl = Math.max(expiresIn - TDX_TOKEN_EXPIRY_BUFFER_SECONDS, KV_MIN_TTL_SECONDS);
    try {
      await env.CACHE.put(TOKEN_CACHE_KEY, accessToken, { expirationTtl: ttl });
    } catch {
      // best-effort: the token still works for this call even if caching it fails
    }
  }

  return accessToken;
}

/**
 * Builds the exact request URL the adapter sends upstream (base + dataset
 * path + any dynamic path segments from `buildPathSegments` + query
 * params). Exported so the fixtures-refresh script can fetch the same raw
 * response a production request would get, without duplicating URL-assembly
 * logic — same reasoning as `buildCwaUrl`/`buildMoenvUrl`. Unlike those two,
 * auth is a bearer header, not baked into the URL, so this doesn't take an
 * access token.
 */
export function buildTdxUrl<TParams, TRaw>(entry: DatasetEntry<TParams, TRaw, unknown>, params: TParams): URL {
  const segments = (entry.buildPathSegments?.(params) ?? []).map(encodeURIComponent);
  const suffix = segments.length > 0 ? `/${segments.join("/")}` : "";
  const url = new URL(`${TDX_API_BASE_URL}/${entry.path}${suffix}`);
  for (const [key, value] of Object.entries(entry.buildQueryParams(params))) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

async function requestWithToken<TParams, TRaw>(
  entry: DatasetEntry<TParams, TRaw, unknown>,
  params: TParams,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<Response> {
  const url = buildTdxUrl(entry, params);
  try {
    return await httpGet(
      url.toString(),
      { headers: { accept: "application/json", authorization: `Bearer ${accessToken}` } },
      fetchImpl
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ToolError({
        code: "UPSTREAM_TIMEOUT",
        message: "TDX 運輸資料流通服務連線逾時（5 秒）。請稍後再試；若持續發生，官方平台可能忙碌或維護中。"
      });
    }
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `無法連線到 TDX 運輸資料流通服務：${error instanceof Error ? error.message : String(error)}。請稍後再試。`
    });
  }
}

async function fetchDataset<TParams, TRaw>(
  entry: DatasetEntry<TParams, TRaw, unknown>,
  params: TParams,
  env: Env,
  fetchImpl: typeof fetch = fetch
): Promise<TRaw> {
  if (!env.TDX_CLIENT_ID || !env.TDX_CLIENT_SECRET) {
    throw new ToolError({ code: "AUTH_MISSING", message: MISSING_CREDENTIALS_MESSAGE });
  }

  let accessToken = await getAccessToken(env, fetchImpl);
  let response = await requestWithToken(entry, params, accessToken, fetchImpl);

  // The cached token may have been rejected even though it looked
  // unexpired client-side (revoked upstream, clock skew, etc.) — per the
  // task's explicit spec, refetch a fresh token once and retry before
  // treating this as a real auth failure.
  if (response.status === 401) {
    accessToken = await getAccessToken(env, fetchImpl, true);
    response = await requestWithToken(entry, params, accessToken, fetchImpl);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ToolError({ code: "AUTH_MISSING", message: invalidCredentialsMessage(`HTTP ${response.status}`) });
  }
  if (!response.ok) {
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `TDX 運輸資料流通服務回應錯誤（HTTP ${response.status}）。請稍後再試。`
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: "TDX 運輸資料流通服務回傳了無法解析的內容，可能是暫時性服務異常，請稍後再試。"
    });
  }

  if (!Array.isArray(payload)) {
    throw new ToolError({
      code: "SCHEMA_MISMATCH",
      message: "TDX 運輸資料流通服務回應格式不符預期（非陣列），可能是資料集路徑錯誤或暫時無資料。"
    });
  }

  return payload as TRaw;
}

export const tdxAdapter: SourceAdapter = {
  id: "tdx",
  displayName: "交通部運輸資料流通服務",
  fetchDataset
};
