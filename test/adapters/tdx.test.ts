import { describe, expect, it } from "vitest";
import { buildTdxUrl, getAccessToken, tdxAdapter } from "../../src/adapters/tdx.js";
import { ToolError } from "../../src/infra/errors.js";
import type { CacheStore } from "../../src/infra/cache.js";
import type { DatasetEntry } from "../../src/registry/index.js";
import { jsonFetch } from "../helpers.js";

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

function makeEntry(
  overrides: Partial<DatasetEntry<{ city: string }, unknown, unknown>> = {}
): DatasetEntry<{ city: string }, unknown, unknown> {
  return {
    id: "tdx:test",
    source: "tdx",
    path: "v2/Bus/EstimatedTimeOfArrival/City",
    title: "test",
    keywords: [],
    paramsSchema: {},
    buildQueryParams: () => ({ $format: "JSON" }),
    buildPathSegments: params => [params.city],
    transform: raw => raw,
    cacheTtlSeconds: 0,
    updateFrequency: "test",
    docUrl: "",
    ...overrides
  };
}

function tokenResponse(accessToken: string, expiresIn: number): typeof fetch {
  return jsonFetch({ access_token: accessToken, expires_in: expiresIn, token_type: "bearer" });
}

describe("buildTdxUrl", () => {
  it("appends path segments and query params, without an access token in the URL", () => {
    const url = buildTdxUrl(makeEntry(), { city: "Taipei" });
    expect(url.pathname).toContain("v2/Bus/EstimatedTimeOfArrival/City/Taipei");
    expect(url.searchParams.get("$format")).toBe("JSON");
    expect(url.toString()).not.toContain("access_token");
  });

  it("URL-encodes each path segment individually", () => {
    const url = buildTdxUrl(makeEntry({ buildPathSegments: () => ["a b", "c/d"] }), { city: "Taipei" });
    expect(url.pathname).toContain("a%20b");
    expect(url.pathname).toContain("c%2Fd");
  });
});

describe("getAccessToken", () => {
  it("throws AUTH_MISSING with the signup URL when no client id/secret is configured", async () => {
    try {
      await getAccessToken({ TDX_CLIENT_ID: undefined, TDX_CLIENT_SECRET: undefined, CACHE: undefined }, fetch);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("AUTH_MISSING");
      expect((error as ToolError).message).toMatch(/tdx\.transportdata\.tw/);
    }
  });

  it("requests a new token and caches it with a TTL shorter than expires_in on a cache miss", async () => {
    const store = makeFakeStore();
    const fetchImpl = tokenResponse("token-1", 3600);

    const token = await getAccessToken({ TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret", CACHE: store }, fetchImpl);

    expect(token).toBe("token-1");
    expect(store.data.get("tdx:access_token")).toBe("token-1");
    expect(store.ttls.get("tdx:access_token")).toBe(3600 - 60); // TDX_TOKEN_EXPIRY_BUFFER_SECONDS
  });

  it("clamps the cached TTL to Cloudflare KV's minimum when expires_in is very short", async () => {
    const store = makeFakeStore();
    const fetchImpl = tokenResponse("token-short", 90);

    await getAccessToken({ TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret", CACHE: store }, fetchImpl);

    // 90 - 60 buffer = 30, below KV's 60s minimum, so it must be clamped up to 60.
    expect(store.ttls.get("tdx:access_token")).toBe(60);
  });

  it("returns the cached token without calling fetchImpl on a cache hit", async () => {
    const store = makeFakeStore();
    store.data.set("tdx:access_token", "cached-token");
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const token = await getAccessToken({ TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret", CACHE: store }, fetchImpl);

    expect(token).toBe("cached-token");
    expect(calls).toBe(0);
  });

  it("requests a fresh token when the cached one has expired (simulated by the fake store returning null)", async () => {
    const store = makeFakeStore();
    // No entry set — same observable state as a KV TTL expiry.
    const fetchImpl = tokenResponse("fresh-token", 3600);

    const token = await getAccessToken({ TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret", CACHE: store }, fetchImpl);

    expect(token).toBe("fresh-token");
  });

  it("skips the cache read entirely when forceRefresh is true, even on a cache hit", async () => {
    const store = makeFakeStore();
    store.data.set("tdx:access_token", "stale-token");
    const fetchImpl = tokenResponse("forced-fresh-token", 3600);

    const token = await getAccessToken(
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret", CACHE: store },
      fetchImpl,
      true
    );

    expect(token).toBe("forced-fresh-token");
    expect(store.data.get("tdx:access_token")).toBe("forced-fresh-token");
  });

  it("throws AUTH_MISSING when the token endpoint returns 401", async () => {
    const fetchImpl = jsonFetch({ error: "unauthorized_client" }, { status: 401 });
    try {
      await getAccessToken({ TDX_CLIENT_ID: "bad", TDX_CLIENT_SECRET: "bad", CACHE: undefined }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("AUTH_MISSING");
      expect((error as ToolError).message).toMatch(/tdx\.transportdata\.tw/);
    }
  });

  it("throws SCHEMA_MISMATCH when the token response is missing access_token/expires_in", async () => {
    const fetchImpl = jsonFetch({ token_type: "bearer" });
    try {
      await getAccessToken({ TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret", CACHE: undefined }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("SCHEMA_MISMATCH");
    }
  });

  it("sends grant_type=client_credentials and the client id/secret as a form-urlencoded POST body", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    await getAccessToken({ TDX_CLIENT_ID: "my-id", TDX_CLIENT_SECRET: "my-secret", CACHE: undefined }, fetchImpl);

    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)?.["content-type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    const body = new URLSearchParams(capturedInit?.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("my-id");
    expect(body.get("client_secret")).toBe("my-secret");
  });
});

describe("tdxAdapter.fetchDataset", () => {
  it("has the expected id and displayName", () => {
    expect(tdxAdapter.id).toBe("tdx");
    expect(tdxAdapter.displayName).toBe("交通部運輸資料流通服務");
  });

  it("throws AUTH_MISSING with the signup URL when no client id/secret is configured", async () => {
    try {
      await tdxAdapter.fetchDataset(makeEntry(), { city: "Taipei" }, { TDX_CLIENT_ID: undefined, TDX_CLIENT_SECRET: undefined });
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("AUTH_MISSING");
      expect((error as ToolError).message).toMatch(/tdx\.transportdata\.tw/);
    }
  });

  it("fetches a token, then sends it as a Bearer header on the data request", async () => {
    let dataRequestAuthHeader: string | undefined;
    let tokenRequested = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url === "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token") {
        tokenRequested = true;
        return new Response(JSON.stringify({ access_token: "abc123", expires_in: 3600 }), { status: 200 });
      }
      dataRequestAuthHeader = (init?.headers as Record<string, string>)?.authorization;
      return new Response(JSON.stringify([{ ok: true }]), { status: 200 });
    }) as unknown as typeof fetch;

    const raw = await tdxAdapter.fetchDataset(
      makeEntry(),
      { city: "Taipei" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      fetchImpl
    );

    expect(tokenRequested).toBe(true);
    expect(dataRequestAuthHeader).toBe("Bearer abc123");
    expect(raw).toEqual([{ ok: true }]);
  });

  it("on a 401 from the data endpoint, force-refreshes the token once and retries before failing", async () => {
    let dataCallCount = 0;
    let tokenCallCount = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url === "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token") {
        tokenCallCount++;
        return new Response(JSON.stringify({ access_token: `token-${tokenCallCount}`, expires_in: 3600 }), {
          status: 200
        });
      }
      dataCallCount++;
      const authHeader = (init?.headers as Record<string, string>)?.authorization;
      if (dataCallCount === 1) {
        expect(authHeader).toBe("Bearer token-1");
        return new Response(JSON.stringify({ message: "token expired" }), { status: 401 });
      }
      expect(authHeader).toBe("Bearer token-2");
      return new Response(JSON.stringify([{ ok: true }]), { status: 200 });
    }) as unknown as typeof fetch;

    const raw = await tdxAdapter.fetchDataset(
      makeEntry(),
      { city: "Taipei" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      fetchImpl
    );

    expect(tokenCallCount).toBe(2);
    expect(dataCallCount).toBe(2);
    expect(raw).toEqual([{ ok: true }]);
  });

  it("throws AUTH_MISSING if the data endpoint still returns 401 after the retry", async () => {
    let tokenCallCount = 0;
    const fetchImpl = (async (url: string) => {
      if (url === "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token") {
        tokenCallCount++;
        return new Response(JSON.stringify({ access_token: `token-${tokenCallCount}`, expires_in: 3600 }), {
          status: 200
        });
      }
      return new Response(JSON.stringify({ message: "still unauthorized" }), { status: 401 });
    }) as unknown as typeof fetch;

    try {
      await tdxAdapter.fetchDataset(
        makeEntry(),
        { city: "Taipei" },
        { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
        fetchImpl
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("AUTH_MISSING");
    }
    expect(tokenCallCount).toBe(2); // initial + the one forced retry, no further attempts
  });

  it("accepts a single-object response, not just a bare array (Rail/Metro/Alert's real shape)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token") {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ AuthorityCode: "TRTC", Alerts: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await tdxAdapter.fetchDataset(
      makeEntry(),
      { city: "Taipei" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      fetchImpl
    );
    expect(result).toEqual({ AuthorityCode: "TRTC", Alerts: [] });
  });

  it("throws SCHEMA_MISMATCH when the data response is neither an array nor an object", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token") {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify("just a string"), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await tdxAdapter.fetchDataset(makeEntry(), { city: "Taipei" }, { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("SCHEMA_MISMATCH");
    }
  });

  it("throws UPSTREAM_ERROR on a non-401 error status from the data endpoint", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token") {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response("server error", { status: 500 });
    }) as unknown as typeof fetch;

    try {
      await tdxAdapter.fetchDataset(makeEntry(), { city: "Taipei" }, { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("UPSTREAM_ERROR");
    }
  });
});
