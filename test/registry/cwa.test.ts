import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recentEarthquakesEntry, tideForecastEntry, weatherForecastEntry } from "../../src/registry/cwa.js";
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
// Confirmed 2026-07-21 via a real dispatch of fixtures-refresh.yml against
// the live API (trimmed to 3 of the ~266 returned locations to keep the
// fixture small — see the module-level comment on tideForecastEntry,
// src/registry/cwa.ts, for the full provenance note).
const tideFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/tide-forecast.json", import.meta.url)), "utf-8")
);

// CWA's IssueTime / ValidTime.EndTime format, confirmed against real captured
// values (test/fixtures/earthquakes.json, e.g. "2026-07-15T22:48:31+08:00") —
// ISO 8601 with a numeric UTC offset.
const ISO_8601_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

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

    expect(result.earthquakes[0].issuedAt).toBe(raw.IssueTime ?? null);
    expect(result.earthquakes[0].validUntil).toBe(raw.ValidTime?.EndTime ?? null);
    if (result.earthquakes[0].issuedAt !== null) {
      expect(result.earthquakes[0].issuedAt).toMatch(ISO_8601_WITH_OFFSET);
    }
    if (result.earthquakes[0].validUntil !== null) {
      expect(result.earthquakes[0].validUntil).toMatch(ISO_8601_WITH_OFFSET);
    }
  });

  it("transform maps IssueTime to issuedAt and ValidTime.EndTime to validUntil", () => {
    const earthquakeWithTimes = {
      EarthquakeNo: 777777,
      ReportType: "地震報告",
      ReportColor: "綠色",
      ReportContent: "測試",
      IssueTime: "2026-03-01T10:00:00+08:00",
      ValidTime: { EndTime: "2026-03-01T18:00:00+08:00" },
      EarthquakeInfo: {
        OriginTime: "2026-03-01 09:55:00",
        Source: "中央氣象署地震測報中心",
        FocalDepth: 10,
        Epicenter: { Location: "測試", EpicenterLatitude: 23.5, EpicenterLongitude: 121 },
        EarthquakeMagnitude: { MagnitudeType: "芮氏規模", MagnitudeValue: 3 }
      },
      Intensity: { ShakingArea: [{ AreaDesc: "A地區", CountyName: "A", AreaIntensity: "1級" }] }
    };

    const result = recentEarthquakesEntry.transform(
      { datasetDescription: "", Earthquake: [earthquakeWithTimes] },
      { limit: 1 }
    );

    expect(result.earthquakes[0].issuedAt).toBe("2026-03-01T10:00:00+08:00");
    expect(result.earthquakes[0].validUntil).toBe("2026-03-01T18:00:00+08:00");
  });

  it("transform falls back to null for issuedAt/validUntil when IssueTime/ValidTime are absent from the raw report", () => {
    const earthquakeWithoutTimes = {
      EarthquakeNo: 666666,
      ReportType: "地震報告",
      ReportColor: "綠色",
      ReportContent: "測試",
      EarthquakeInfo: {
        OriginTime: "2026-03-01 09:55:00",
        Source: "中央氣象署地震測報中心",
        FocalDepth: 10,
        Epicenter: { Location: "測試", EpicenterLatitude: 23.5, EpicenterLongitude: 121 },
        EarthquakeMagnitude: { MagnitudeType: "芮氏規模", MagnitudeValue: 3 }
      },
      Intensity: { ShakingArea: [{ AreaDesc: "A地區", CountyName: "A", AreaIntensity: "1級" }] }
    };

    const result = recentEarthquakesEntry.transform(
      { datasetDescription: "", Earthquake: [earthquakeWithoutTimes] },
      { limit: 1 }
    );

    expect(result.earthquakes[0].issuedAt).toBeNull();
    expect(result.earthquakes[0].validUntil).toBeNull();
  });

  it("transform returns an empty list (not an error) when there are no earthquakes", () => {
    const result = recentEarthquakesEntry.transform({ datasetDescription: "", Earthquake: [] }, { limit: 3 });
    expect(result.earthquakes).toEqual([]);
  });
});

describe("tideForecastEntry", () => {
  it("is registered under cwa:F-A0021-001 and matches the imported entry", () => {
    expect(getDatasetEntry("cwa:F-A0021-001")).toBe(tideForecastEntry);
  });

  it("buildQueryParams passes locationName through verbatim", () => {
    expect(tideForecastEntry.buildQueryParams({ locationName: "宜蘭縣南澳鄉" })).toEqual({
      locationName: "宜蘭縣南澳鄉"
    });
  });

  it("transform finds the requested location and passes its forecast entries through", () => {
    const rawEntry = tideFixture.records.TideForecasts[0];
    const rawLocation = rawEntry.Location;
    const result = tideForecastEntry.transform(tideFixture.records, { locationName: rawLocation.LocationName });

    expect(result.locationName).toBe(rawLocation.LocationName);
    expect(result.stationId).toBe(rawLocation.LocationId);
    expect(result.forecast).toEqual(rawLocation.TimePeriods.Daily);
    expect(result.forecast).toHaveLength(rawLocation.TimePeriods.Daily.length);
  });

  it("transform re-filters client-side even though the fixture (like real CWA traffic) returns every location regardless of the requested locationName", () => {
    expect(tideFixture.records.TideForecasts.length).toBeGreaterThan(1);
    const rawEntry = tideFixture.records.TideForecasts[1];
    const rawLocation = rawEntry.Location;
    const result = tideForecastEntry.transform(tideFixture.records, { locationName: rawLocation.LocationName });

    expect(result.locationName).toBe(rawLocation.LocationName);
  });

  it("transform throws NOT_FOUND for a locationName not present in the response", () => {
    try {
      tideForecastEntry.transform(tideFixture.records, { locationName: "不存在的地點" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("NOT_FOUND");
      expect((error as ToolError).message).toContain("不存在的地點");
    }
  });
});
