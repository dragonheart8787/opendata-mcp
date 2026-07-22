/**
 * Thin fetch wrapper shared by all adapters: a fixed 5-second timeout and a
 * single retry. Originally GET-only (the only method this project issued to
 * an upstream, so retrying was always safe/idempotent by construction).
 * `httpPost` was added for the TDX adapter's OAuth2 client_credentials token
 * endpoint — a `client_credentials` grant request has no side effects
 * beyond issuing a token, so it's safe to retry the same way GET is; this
 * project still never issues a POST with side effects (creating/mutating
 * upstream state), so the "every request here is safely retryable" premise
 * still holds.
 *
 * This didn't exist before the layered refactor (adapters called `fetch`
 * directly with no timeout), so there is no prior behavior to preserve
 * here — it's new infrastructure the architecture doc asks for. It's
 * additive: a slow-but-eventually-successful upstream call behaves exactly
 * as before (just now bounded), and a call that fails outright still fails,
 * just after one extra attempt.
 */

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 1;

export interface HttpGetOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

export interface HttpPostOptions extends HttpGetOptions {
  body?: string;
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function request(
  method: "GET" | "POST",
  url: string,
  options: HttpPostOptions,
  fetchImpl: typeof fetch
): Promise<Response> {
  const { headers, body, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      // loop again if attempts remain, otherwise fall through to throw below
    }
  }
  throw lastError;
}

/**
 * Issues a single GET request with a timeout, retrying once (by default) on
 * any failure — network error or timeout alike. Never retries based on the
 * response's HTTP status; a non-2xx response is a successful fetch as far
 * as this wrapper is concerned, and is returned as-is for the caller to
 * interpret.
 */
export async function httpGet(
  url: string,
  options: HttpGetOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  return request("GET", url, options, fetchImpl);
}

/** Same timeout/retry/status-handling contract as `httpGet`, for POST requests (currently only the TDX token endpoint). */
export async function httpPost(
  url: string,
  options: HttpPostOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  return request("POST", url, options, fetchImpl);
}
