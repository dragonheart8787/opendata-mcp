/**
 * Minimal structural interface for a KV-style cache. Cloudflare's
 * `KVNamespace` satisfies it directly; tests provide an in-memory fake.
 * Kept structural (instead of referencing `KVNamespace`) so the test
 * project can typecheck without Workers ambient types.
 */
export interface CacheStore {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Reads `key` from the cache, or runs `fetcher` and stores its JSON-serialized
 * result with the given TTL, tagging whether the value came from cache.
 * The cache is strictly best-effort: a missing store, a corrupt entry, or a
 * KV read/write failure all fall through to `fetcher` — a cache problem
 * must never break a tool call. Errors thrown by `fetcher` itself are never
 * cached.
 */
export async function withCacheTracked<T>(
  store: CacheStore | undefined,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<{ value: T; cached: boolean }> {
  if (store) {
    try {
      const cached = await store.get(key, "text");
      if (cached !== null) {
        return { value: JSON.parse(cached) as T, cached: true };
      }
    } catch {
      // fall through to fetcher
    }
  }

  const result = await fetcher();

  if (store) {
    try {
      await store.put(key, JSON.stringify(result), { expirationTtl: ttlSeconds });
    } catch {
      // best-effort: serving the fresh result matters more than caching it
    }
  }

  return { value: result, cached: false };
}

/**
 * Same behavior as `withCacheTracked`, for callers that don't need the
 * cache-hit flag. Kept as a separate export (rather than having every call
 * site destructure `.value`) since it's a straight carry-over of the
 * pre-refactor `withCache` API and its existing test suite.
 */
export async function withCache<T>(
  store: CacheStore | undefined,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const { value } = await withCacheTracked(store, key, ttlSeconds, fetcher);
  return value;
}
