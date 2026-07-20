import { describe, expect, it } from "vitest";
import { withCache, type CacheStore } from "../src/services/cache.js";

function makeFakeStore(): CacheStore & { data: Map<string, string>; ttls: Map<string, number | undefined> } {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  return {
    data,
    ttls,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value, options) {
      data.set(key, value);
      ttls.set(key, options?.expirationTtl);
    }
  };
}

describe("withCache", () => {
  it("calls the fetcher and stores the result with the given TTL on a miss", async () => {
    const store = makeFakeStore();
    let calls = 0;

    const result = await withCache(store, "weather:臺北市", 1800, async () => {
      calls++;
      return { city: "臺北市" };
    });

    expect(result).toEqual({ city: "臺北市" });
    expect(calls).toBe(1);
    expect(store.data.get("weather:臺北市")).toBe(JSON.stringify({ city: "臺北市" }));
    expect(store.ttls.get("weather:臺北市")).toBe(1800);
  });

  it("returns the cached value without calling the fetcher on a hit", async () => {
    const store = makeFakeStore();
    store.data.set("quakes:3", JSON.stringify({ earthquakes: [] }));
    let calls = 0;

    const result = await withCache(store, "quakes:3", 300, async () => {
      calls++;
      return { earthquakes: [{ earthquakeNo: 1 }] };
    });

    expect(result).toEqual({ earthquakes: [] });
    expect(calls).toBe(0);
  });

  it("keys are distinct per query so different cities don't overwrite each other", async () => {
    const store = makeFakeStore();
    await withCache(store, "weather:臺北市", 1800, async () => ({ city: "臺北市" }));
    await withCache(store, "weather:高雄市", 1800, async () => ({ city: "高雄市" }));

    expect(store.data.size).toBe(2);
    const taipei = await withCache(store, "weather:臺北市", 1800, async () => ({ city: "wrong" }));
    expect(taipei).toEqual({ city: "臺北市" });
  });

  it("works without a store (cache disabled)", async () => {
    const result = await withCache(undefined, "aqi:county:新北市", 600, async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it("falls back to the fetcher when the cache read throws or holds corrupt JSON", async () => {
    const store = makeFakeStore();
    store.data.set("weather:臺北市", "{not json");
    const result = await withCache(store, "weather:臺北市", 1800, async () => ({ city: "臺北市" }));
    expect(result).toEqual({ city: "臺北市" });

    const throwingStore: CacheStore = {
      async get() {
        throw new Error("kv down");
      },
      async put() {
        throw new Error("kv down");
      }
    };
    const result2 = await withCache(throwingStore, "k", 60, async () => "fresh");
    expect(result2).toBe("fresh");
  });

  it("does not cache fetcher errors", async () => {
    const store = makeFakeStore();
    await expect(
      withCache(store, "quakes:3", 300, async () => {
        throw new Error("upstream down");
      })
    ).rejects.toThrow("upstream down");
    expect(store.data.size).toBe(0);

    const result = await withCache(store, "quakes:3", 300, async () => "recovered");
    expect(result).toBe("recovered");
  });
});
