/**
 * Minimal structural interface for Cloudflare's native Rate Limiting
 * binding (`RateLimit` in @cloudflare/workers-types). Kept structural
 * instead of referencing that ambient type directly — same reason
 * `CacheStore` (infra/cache.ts) is structural: test/tsconfig.json doesn't
 * load Workers ambient types, and tests provide a simple fake implementing
 * this shape instead.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** How long (seconds) a limited caller is told to wait before retrying — matches wrangler.toml's `period` for the RATE_LIMITER binding. */
const RETRY_AFTER_SECONDS = 60;

/**
 * Checks a per-key rate limit and returns a ready-to-send 429 Response if
 * the caller is over budget, or `null` if the request should proceed.
 *
 * Fail-soft like every other piece of optional infra in this project
 * (KV caching, TDX token caching): a missing binding or a limiter-check
 * failure never blocks a real request. Rate limiting exists to protect
 * this demo's own shared upstream API quota (CWA/MOENV/TDX) from abuse —
 * it must not itself become a new single point of failure for a query
 * that would otherwise have succeeded.
 */
export async function checkRateLimit(limiter: RateLimiter | undefined, key: string): Promise<Response | null> {
  if (!limiter) return null;

  let allowed: boolean;
  try {
    ({ success: allowed } = await limiter.limit({ key }));
  } catch {
    return null;
  }

  if (allowed) return null;

  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Too many requests from this IP address. This is a shared public demo with a per-IP rate limit, " +
          "protecting its own upstream API quota from abuse. Please wait and retry (see the Retry-After " +
          "header, in seconds). For reliable or high-volume use, self-host your own instance — see " +
          "https://github.com/dragonheart8787/opendata-mcp#自行部署"
      },
      id: null
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(RETRY_AFTER_SECONDS)
      }
    }
  );
}
