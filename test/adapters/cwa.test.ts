import { describe, expect, it } from "vitest";
import { cwaAdapter } from "../../src/adapters/cwa.js";
import { ToolError } from "../../src/infra/errors.js";
import type { DatasetEntry } from "../../src/registry/index.js";
import { jsonFetch } from "../helpers.js";

function makeEntry(overrides: Partial<DatasetEntry<{ x?: string }, unknown, unknown>> = {}): DatasetEntry<
  { x?: string },
  unknown,
  unknown
> {
  return {
    id: "cwa:test",
    source: "cwa",
    path: "F-C0032-001",
    title: "test",
    keywords: [],
    paramsSchema: {},
    buildQueryParams: () => ({}),
    transform: raw => raw,
    cacheTtlSeconds: 0,
    updateFrequency: "test",
    docUrl: "",
    ...overrides
  };
}

describe("cwaAdapter", () => {
  it("has the expected id and displayName", () => {
    expect(cwaAdapter.id).toBe("cwa");
    expect(cwaAdapter.displayName).toBe("中央氣象署");
  });

  it("throws AUTH_MISSING with the signup URL when no API key is configured", async () => {
    await expect(cwaAdapter.fetchDataset(makeEntry(), {}, { CWA_API_KEY: undefined })).rejects.toThrow(ToolError);
    try {
      await cwaAdapter.fetchDataset(makeEntry(), {}, { CWA_API_KEY: undefined });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("AUTH_MISSING");
      expect((error as ToolError).message).toMatch(/opendata\.cwa\.gov\.tw\/user\/authkey/);
    }
  });

  it("injects Authorization and format=JSON into the request URL", async () => {
    let requestedUrl = "";
    const capturingFetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ success: "true", records: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    await cwaAdapter.fetchDataset(
      makeEntry({ buildQueryParams: () => ({ locationName: "臺北市" }) }),
      {},
      { CWA_API_KEY: "test-key" },
      capturingFetch
    );

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("Authorization")).toBe("test-key");
    expect(url.searchParams.get("format")).toBe("JSON");
    expect(url.searchParams.get("locationName")).toBe("臺北市");
    expect(url.pathname).toContain("F-C0032-001");
  });

  it("throws AUTH_MISSING on HTTP 401/403", async () => {
    const fetchImpl = jsonFetch({ success: "false" }, { status: 401 });
    try {
      await cwaAdapter.fetchDataset(makeEntry(), {}, { CWA_API_KEY: "bad-key" }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("AUTH_MISSING");
      expect((error as ToolError).message).toMatch(/opendata\.cwa\.gov\.tw\/user\/authkey/);
    }
  });

  it("throws AUTH_MISSING when success:false carries an auth-related message", async () => {
    const fetchImpl = jsonFetch({ success: "false", message: "Invalid Authorization key, please check." });
    try {
      await cwaAdapter.fetchDataset(makeEntry(), {}, { CWA_API_KEY: "bad-key" }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("AUTH_MISSING");
      expect((error as ToolError).message).toMatch(/opendata\.cwa\.gov\.tw\/user\/authkey/);
    }
  });

  it("throws UPSTREAM_ERROR (eventually, after one retry) on a network failure", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error("boom");
    }) as unknown as typeof fetch;

    try {
      await cwaAdapter.fetchDataset(makeEntry(), {}, { CWA_API_KEY: "key" }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("UPSTREAM_ERROR");
      expect((error as ToolError).message).toMatch(/無法連線/);
    }
    expect(calls).toBe(2); // infra/http.ts's single retry
  });

  it("returns the unwrapped records payload on success", async () => {
    const fetchImpl = jsonFetch({ success: "true", records: { hello: "world" } });
    const raw = await cwaAdapter.fetchDataset(makeEntry(), {}, { CWA_API_KEY: "key" }, fetchImpl);
    expect(raw).toEqual({ hello: "world" });
  });

  it("throws SCHEMA_MISMATCH when records is missing even though success is true", async () => {
    const fetchImpl = jsonFetch({ success: "true" });
    try {
      await cwaAdapter.fetchDataset(makeEntry(), {}, { CWA_API_KEY: "key" }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("SCHEMA_MISMATCH");
      expect((error as ToolError).message).toMatch(/records/);
    }
  });
});
