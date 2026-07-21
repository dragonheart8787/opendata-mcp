import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Side-effect imports: registers the cwa/moenv registry entries these tests query against.
import "../../src/registry/cwa.js";
import "../../src/registry/moenv.js";
import {
  formatSearchDatasetsText,
  handleQueryDatasetTool,
  handleSearchDatasetsTool,
  runQueryDataset,
  runSearchDatasets
} from "../../src/tools/generic.js";
import type { CacheStore } from "../../src/infra/cache.js";
import { jsonFetch } from "../helpers.js";

const earthquakeFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/earthquakes.json", import.meta.url)), "utf-8")
);
const airQualityFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/air-quality.json", import.meta.url)), "utf-8")
);

function makeFakeStore(): CacheStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    }
  };
}

describe("runSearchDatasets", () => {
  it("matches by title substring", () => {
    const result = runSearchDatasets("地震報告");
    expect(result.results.map(r => r.datasetId)).toContain("cwa:E-A0015-001");
  });

  it("matches by keyword substring, case-insensitively", () => {
    const result = runSearchDatasets("aqi"); // keyword is stored as "AQI"
    expect(result.results.map(r => r.datasetId)).toContain("moenv:aqx_p_432");
  });

  it("filters by source", () => {
    const cwaOnly = runSearchDatasets("地震", "cwa");
    expect(cwaOnly.results.map(r => r.datasetId)).toContain("cwa:E-A0015-001");

    const moenvOnly = runSearchDatasets("地震", "moenv");
    expect(moenvOnly.results).toEqual([]);
  });

  it("returns an empty results array (not an error) for no match", () => {
    const result = runSearchDatasets("不存在的關鍵字xyz123");
    expect(result.results).toEqual([]);
  });

  it("describes each param's name, description, and required-ness", () => {
    const result = runSearchDatasets("36 小時天氣預報");
    const weather = result.results.find(r => r.datasetId === "cwa:F-C0032-001");
    expect(weather?.params).toEqual([{ name: "city", description: expect.any(String), required: true }]);

    const airQuality = runSearchDatasets("空氣品質指標").results.find(r => r.datasetId === "moenv:aqx_p_432");
    expect(airQuality?.params).toEqual([
      { name: "county", description: expect.any(String), required: false },
      { name: "siteName", description: expect.any(String), required: false }
    ]);

    // limit has a zod .default(), which zod treats as optional-for-input even without .optional().
    const earthquakes = runSearchDatasets("地震報告").results.find(r => r.datasetId === "cwa:E-A0015-001");
    expect(earthquakes?.params).toEqual([{ name: "limit", description: expect.any(String), required: false }]);
  });

  it("surfaces each result's source as the adapter's display name", () => {
    const result = runSearchDatasets("地震報告");
    expect(result.results.find(r => r.datasetId === "cwa:E-A0015-001")?.source).toBe("中央氣象署");
  });
});

describe("formatSearchDatasetsText", () => {
  it("renders a no-match message when there are no results", () => {
    const text = formatSearchDatasetsText(runSearchDatasets("不存在的關鍵字xyz123"));
    expect(text).toContain("找不到符合");
  });

  it("renders datasetId, title, source, and params for each match", () => {
    const text = formatSearchDatasetsText(runSearchDatasets("地震報告"));
    expect(text).toContain("cwa:E-A0015-001");
    expect(text).toContain("顯著有感地震報告");
    expect(text).toContain("中央氣象署");
    expect(text).toContain("limit");
  });
});

describe("handleSearchDatasetsTool", () => {
  it("returns ok:true with the results nested under structuredContent.data", () => {
    const result = handleSearchDatasetsTool({ query: "地震報告" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.ok).toBe(true);
    const data = result.structuredContent.data as { results: Array<{ datasetId: string }> };
    expect(data.results.map(r => r.datasetId)).toContain("cwa:E-A0015-001");
  });
});

describe("runQueryDataset", () => {
  it("dispatches a cwa dataset to the cwa adapter and applies its transform", async () => {
    const { entry, data } = await runQueryDataset(
      "cwa:E-A0015-001",
      { limit: 1 },
      { CWA_API_KEY: "test-key" },
      jsonFetch(earthquakeFixture)
    );
    expect(entry.id).toBe("cwa:E-A0015-001");
    const result = data as { earthquakes: Array<{ earthquakeNo: number }> };
    expect(result.earthquakes).toHaveLength(1);
    expect(result.earthquakes[0].earthquakeNo).toBe(earthquakeFixture.records.Earthquake[0].EarthquakeNo);
  });

  it("dispatches a moenv dataset to the moenv adapter and applies its transform", async () => {
    const { entry, data } = await runQueryDataset(
      "moenv:aqx_p_432",
      { county: "新北市" },
      { MOENV_API_KEY: "test-key" },
      jsonFetch(airQualityFixture)
    );
    expect(entry.id).toBe("moenv:aqx_p_432");
    const result = data as { stations: Array<{ county: string }> };
    expect(result.stations.length).toBeGreaterThan(0);
    expect(result.stations.every(s => s.county === "新北市")).toBe(true);
  });

  it("throws NOT_FOUND with a tw_search_datasets hint for an unknown datasetId", async () => {
    await expect(runQueryDataset("cwa:NOT-A-REAL-ID", {}, { CWA_API_KEY: "test-key" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("tw_search_datasets")
    });
  });

  it("throws INVALID_PARAMS naming the offending field when params fail the entry's schema", async () => {
    await expect(
      runQueryDataset("cwa:E-A0015-001", { limit: "not-a-number" }, { CWA_API_KEY: "test-key" })
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("limit")
    });
  });

  it("throws INVALID_PARAMS when a required param is missing entirely", async () => {
    await expect(runQueryDataset("cwa:F-C0032-001", {}, { CWA_API_KEY: "test-key" })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("city")
    });
  });
});

describe("handleQueryDatasetTool", () => {
  it("returns the same envelope shape (ok/source/dataset/cached/updateFrequency/data) as the curated tools", async () => {
    const result = await handleQueryDatasetTool(
      { datasetId: "cwa:E-A0015-001", params: { limit: 1 } },
      { CWA_API_KEY: "test-key" },
      jsonFetch(earthquakeFixture)
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.source).toBe("中央氣象署");
    expect(result.structuredContent.dataset).toBe("E-A0015-001");
    expect(result.structuredContent.cached).toBe(false);
    expect(result.structuredContent.updateFrequency).toBe("地震發生時即時發布");
    expect((result.structuredContent.data as { earthquakes: unknown[] }).earthquakes).toHaveLength(1);
  });

  it("returns a failure envelope (isError, ok:false, error.code) for an unknown datasetId", async () => {
    const result = await handleQueryDatasetTool({ datasetId: "cwa:NOPE" }, { CWA_API_KEY: "test-key" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.ok).toBe(false);
    expect((result.structuredContent.error as { code: string }).code).toBe("NOT_FOUND");
  });

  it("returns a failure envelope for invalid params", async () => {
    const result = await handleQueryDatasetTool(
      { datasetId: "cwa:E-A0015-001", params: { limit: "not-a-number" } },
      { CWA_API_KEY: "test-key" }
    );
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { code: string }).code).toBe("INVALID_PARAMS");
  });

  it("caches successful results and reports cached:true on the second call with identical params", async () => {
    const cache = makeFakeStore();
    let fetchCount = 0;
    const countingFetch: typeof fetch = (async (url: string) => {
      fetchCount++;
      return new Response(JSON.stringify(earthquakeFixture), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const first = await handleQueryDatasetTool(
      { datasetId: "cwa:E-A0015-001", params: { limit: 1 } },
      { CWA_API_KEY: "test-key", CACHE: cache },
      countingFetch
    );
    const second = await handleQueryDatasetTool(
      { datasetId: "cwa:E-A0015-001", params: { limit: 1 } },
      { CWA_API_KEY: "test-key", CACHE: cache },
      countingFetch
    );

    expect(first.structuredContent.cached).toBe(false);
    expect(second.structuredContent.cached).toBe(true);
    expect(fetchCount).toBe(1);
  });

  it("uses an order-independent cache key, so {limit:1} and re-supplying the same param differently ordered share a cache entry", async () => {
    const cache = makeFakeStore();
    const result1 = await handleQueryDatasetTool(
      { datasetId: "cwa:E-A0015-001", params: { limit: 1 } },
      { CWA_API_KEY: "test-key", CACHE: cache },
      jsonFetch(earthquakeFixture)
    );
    // Same logical params, different insertion order — should hit the same cache key.
    const differentlyOrderedParams: Record<string, unknown> = {};
    differentlyOrderedParams.limit = 1;
    const result2 = await handleQueryDatasetTool(
      { datasetId: "cwa:E-A0015-001", params: differentlyOrderedParams },
      { CWA_API_KEY: "test-key", CACHE: cache },
      jsonFetch(earthquakeFixture)
    );

    expect(result1.structuredContent.cached).toBe(false);
    expect(result2.structuredContent.cached).toBe(true);
  });
});
