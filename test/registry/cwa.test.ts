import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recentEarthquakesEntry, weatherForecastEntry } from "../../src/registry/cwa.js";
import { getDatasetEntry } from "../../src/registry/index.js";
import { ToolError } from "../../src/infra/errors.js";

// Both fixtures are overwritten with real, live API responses whenever
// scripts/fixtures/refresh-fixtures.ts detects structural drift — so their
// specific values (temperatures, earthquake content) change over time.
// Tests below derive expected values from each fixture's own raw fields
// rather than hardcoding literals, so a routine refresh never breaks them
// on its own.
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

  it("transform extracts a compact per-period forecast matching the raw CWA fields", () => {
    const location = weatherFixture.records.location.find((l: any) => l.locationName === "臺北市");
    const findElement = (elementName: string) => location.weatherElement.find((e: any) => e.elementName === elementName);
    const wx = findElement("Wx");
    const pop = findElement("PoP");
    const minT = findElement("MinT");
    const maxT = findElement("MaxT");
    const ci = findElement("CI");

    const result = weatherForecastEntry.transform(weatherFixture.records, { city: "臺北市" });

    expect(result.city).toBe("臺北市");
    expect(result.periods).toHaveLength(wx.time.length);
    result.periods.forEach((period, i) => {
      expect(period.startTime).toBe(wx.time[i].startTime);
      expect(period.endTime).toBe(wx.time[i].endTime);
      expect(period.weather).toBe(wx.time[i].parameter.parameterName);
      expect(period.rainProbabilityPercent).toBe(Number(pop.time[i].parameter.parameterName));
      expect(period.minTemperatureC).toBe(Number(minT.time[i].parameter.parameterName));
      expect(period.maxTemperatureC).toBe(Number(maxT.time[i].parameter.parameterName));
      expect(period.comfortIndex).toBe(ci.time[i].parameter.parameterName);
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
    const raw = earthquakeFixture.records.Earthquake[0];
    const result = recentEarthquakesEntry.transform(earthquakeFixture.records, { limit: 1 });

    expect(result.earthquakes).toHaveLength(1);
    expect(result.earthquakes[0].earthquakeNo).toBe(raw.EarthquakeNo);
    expect(typeof result.earthquakes[0].maxIntensity).toBe("string");
    expect(result.earthquakes[0].maxIntensity.length).toBeGreaterThan(0);
  });

  it("transform returns an empty list (not an error) when there are no earthquakes", () => {
    const result = recentEarthquakesEntry.transform({ datasetDescription: "", Earthquake: [] }, { limit: 3 });
    expect(result.earthquakes).toEqual([]);
  });
});
