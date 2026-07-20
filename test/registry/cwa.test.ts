import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recentEarthquakesEntry, weatherForecastEntry } from "../../src/registry/cwa.js";
import { getDatasetEntry } from "../../src/registry/index.js";
import { ToolError } from "../../src/infra/errors.js";

const weatherFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/weather-forecast.json", import.meta.url)), "utf-8")
);
const earthquakeFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/earthquakes.json", import.meta.url)), "utf-8")
);

describe("weatherForecastEntry", () => {
  it("is registered under cwa:F-C0032-001 and matches the imported entry", () => {
    expect(getDatasetEntry("cwa:F-C0032-001")).toBe(weatherForecastEntry);
  });

  it("buildQueryParams maps city to CWA's locationName param", () => {
    expect(weatherForecastEntry.buildQueryParams({ city: "臺北市" })).toEqual({ locationName: "臺北市" });
  });

  it("transform extracts a compact per-period forecast from the raw CWA records", () => {
    const result = weatherForecastEntry.transform(weatherFixture.records, { city: "臺北市" });

    expect(result.city).toBe("臺北市");
    expect(result.periods).toHaveLength(3);
    expect(result.periods[0]).toEqual({
      startTime: "2026-07-19 18:00:00",
      endTime: "2026-07-20 06:00:00",
      weather: "多雲時晴",
      rainProbabilityPercent: 10,
      minTemperatureC: 27,
      maxTemperatureC: 30,
      comfortIndex: "舒適"
    });
  });

  it("transform throws NOT_FOUND when the requested city isn't in the response", () => {
    try {
      weatherForecastEntry.transform(weatherFixture.records, { city: "高雄市" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("NOT_FOUND");
      expect((error as ToolError).message).toContain("高雄市");
    }
  });
});

describe("recentEarthquakesEntry", () => {
  it("is registered under cwa:E-A0015-001 and matches the imported entry", () => {
    expect(getDatasetEntry("cwa:E-A0015-001")).toBe(recentEarthquakesEntry);
  });

  it("buildQueryParams maps limit to CWA's limit param as a string", () => {
    expect(recentEarthquakesEntry.buildQueryParams({ limit: 3 })).toEqual({ limit: "3" });
  });

  it("transform summarizes earthquakes and respects limit", () => {
    const result = recentEarthquakesEntry.transform(earthquakeFixture.records, { limit: 1 });
    expect(result.earthquakes).toHaveLength(1);
    expect(result.earthquakes[0].earthquakeNo).toBe(114078);
    expect(result.earthquakes[0].maxIntensity).toBe("4級");
  });

  it("transform returns an empty list (not an error) when there are no earthquakes", () => {
    const result = recentEarthquakesEntry.transform({ datasetDescription: "", Earthquake: [] }, { limit: 3 });
    expect(result.earthquakes).toEqual([]);
  });
});
