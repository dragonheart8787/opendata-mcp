import { describe, expect, it } from "vitest";
import { moenvAdapter, normalizeMoenvRecord } from "../../src/adapters/moenv.js";
import { ToolError } from "../../src/infra/errors.js";
import type { DatasetEntry } from "../../src/registry/index.js";
import { jsonFetch } from "../helpers.js";

function makeEntry(overrides: Partial<DatasetEntry<Record<string, never>, unknown, unknown>> = {}): DatasetEntry<
  Record<string, never>,
  unknown,
  unknown
> {
  return {
    id: "moenv:test",
    source: "moenv",
    path: "aqx_p_432",
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

describe("normalizeMoenvRecord", () => {
  it("maps '', '-', and 'ND' string fields to null", () => {
    const result = normalizeMoenvRecord({ pm25: "", o3: "-", pollutant: "ND", aqi: "62", county: "新北市" });
    expect(result).toEqual({ pm25: null, o3: null, pollutant: null, aqi: "62", county: "新北市" });
  });

  it("leaves non-string fields untouched", () => {
    const result = normalizeMoenvRecord({ count: 5, flag: true, name: "" });
    expect(result).toEqual({ count: 5, flag: true, name: null });
  });
});

describe("moenvAdapter", () => {
  it("has the expected id and displayName", () => {
    expect(moenvAdapter.id).toBe("moenv");
    expect(moenvAdapter.displayName).toBe("環境部");
  });

  it("throws AUTH_MISSING with the signup URL when no API key is configured", async () => {
    try {
      await moenvAdapter.fetchDataset(makeEntry(), {}, { MOENV_API_KEY: undefined });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("AUTH_MISSING");
      expect((error as ToolError).message).toMatch(/data\.moenv\.gov\.tw/);
    }
  });

  it("injects api_key as a query parameter (not a header)", async () => {
    let requestedUrl = "";
    const capturingFetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify([{ sitename: "士林" }]), { status: 200 });
    }) as unknown as typeof fetch;

    await moenvAdapter.fetchDataset(
      makeEntry({ buildQueryParams: () => ({ filters: "county,EQ,臺北市" }) }),
      {},
      { MOENV_API_KEY: "test-key" },
      capturingFetch
    );

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("api_key")).toBe("test-key");
    expect(url.searchParams.get("filters")).toBe("county,EQ,臺北市");
  });

  it("accepts a bare JSON array response and normalizes missing-value markers", async () => {
    const fetchImpl = jsonFetch([{ sitename: "士林", pm10: "", o3: "-", pollutant: "ND", aqi: "30" }]);
    const raw = await moenvAdapter.fetchDataset(makeEntry(), {}, { MOENV_API_KEY: "key" }, fetchImpl);
    expect(raw).toEqual([{ sitename: "士林", pm10: null, o3: null, pollutant: null, aqi: "30" }]);
  });

  it("still accepts a { records: [...] } wrapped response", async () => {
    const fetchImpl = jsonFetch({ resource_id: "aqx_p_432", records: [{ sitename: "士林" }] });
    const raw = await moenvAdapter.fetchDataset(makeEntry(), {}, { MOENV_API_KEY: "key" }, fetchImpl);
    expect(raw).toEqual([{ sitename: "士林" }]);
  });

  it("throws SCHEMA_MISMATCH when the object response has no message and no array field", async () => {
    const fetchImpl = jsonFetch({ resource_id: "aqx_p_432" });
    try {
      await moenvAdapter.fetchDataset(makeEntry(), {}, { MOENV_API_KEY: "key" }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("SCHEMA_MISMATCH");
      expect((error as ToolError).message).toMatch(/格式不符|找不到記錄陣列/);
    }
  });

  it("throws AUTH_MISSING when the object response is an invalid-key error envelope", async () => {
    const fetchImpl = jsonFetch({ message: "api_key is not valid" });
    try {
      await moenvAdapter.fetchDataset(makeEntry(), {}, { MOENV_API_KEY: "bad-key" }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("AUTH_MISSING");
      expect((error as ToolError).message).toMatch(/data\.moenv\.gov\.tw/);
    }
  });

  it("throws AUTH_MISSING on HTTP 401", async () => {
    const fetchImpl = jsonFetch({ message: "unauthorized" }, { status: 401 });
    try {
      await moenvAdapter.fetchDataset(makeEntry(), {}, { MOENV_API_KEY: "bad-key" }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("AUTH_MISSING");
      expect((error as ToolError).message).toMatch(/data\.moenv\.gov\.tw/);
    }
  });
});
