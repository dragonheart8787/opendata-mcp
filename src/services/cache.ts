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
 * result with the given TTL. The cache is strictly best-effort: a missing
 * store, a corrupt entry, or a KV read/write failure all fall through to
 * `fetcher` — a cache problem must never break a tool call. Errors thrown by
 * `fetcher` itself are never cached.
 */
export async function withCache<T>(
  store: CacheStore | undefined,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  if (store) {
    try {
      const cached = await store.get(key, "text");
      if (cached !== null) {
        return JSON.parse(cached) as T;
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

  return result;
}
