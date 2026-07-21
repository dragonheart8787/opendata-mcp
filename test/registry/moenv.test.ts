import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AQX_P_432_FETCH_LIMIT } from "../../src/constants.js";
import { ToolError } from "../../src/infra/errors.js";
import { normalizeMoenvRecord } from "../../src/adapters/moenv.js";
import {
  airQualityEntry,
  airQualityForecastEntry,
  uvRealtimeEntry,
  validateAirQualityParams
} from "../../src/registry/moenv.js";
import { getDatasetEntry } from "../../src/registry/index.js";

// This fixture is overwritten with a real, live response whenever
// scripts/fixtures/refresh-fixtures.ts detects structural drift — so its
// specific readings change over time. Tests below derive expected values
// from the fixture's own raw fields rather than hardcoding literals, so a
// routine refresh never breaks them on its own.
const rawFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/air-quality.json", import.meta.url)), "utf-8")
);
// Registry transforms receive already-normalized raw records (the adapter's job),
// so run the fixture through the same normalization the adapter applies.
const fixture = rawFixture.map(normalizeMoenvRecord);

// Field names below come from each dataset's own description page content,
// not a fresh direct capture from this session — see the module-level
// comments on airQualityForecastEntry/uvRealtimeEntry (src/registry/moenv.ts)
// for the full provenance note. Needs a real capture via
// fixtures-refresh.yml to raise confidence.
const airQualityForecastFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/air-quality-forecast.json", import.meta.url)), "utf-8")
).map(normalizeMoenvRecord);
const uvRealtimeFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/uv-realtime.json", import.meta.url)), "utf-8")
).map(normalizeMoenvRecord);

describe("airQualityEntry", () => {
  it("is registered under moenv:aqx_p_432 and matches the imported entry", () => {
    expect(getDatasetEntry("moenv:aqx_p_432")).toBe(airQualityEntry);
  });

  it("buildQueryParams builds filters=county,EQ,{county} for a county query", () => {
    expect(airQualityEntry.buildQueryParams({ county: "臺北市" })).toEqual({
      filters: "county,EQ,臺北市",
      limit: String(AQX_P_432_FETCH_LIMIT)
    });
  });

  it("buildQueryParams builds filters=sitename,EQ,{siteName} for a station query", () => {
    expect(airQualityEntry.buildQueryParams({ siteName: "板橋" })).toEqual({
      filters: "sitename,EQ,板橋",
      limit: String(AQX_P_432_FETCH_LIMIT)
    });
  });

  it("transform summarizes all stations matching a county", () => {
    const rawMatches = rawFixture.filter((r: any) => r.county === "新北市");
    const result = airQualityEntry.transform(fixture, { county: "新北市" });

    expect(result.query).toEqual({ county: "新北市" });
    expect(result.stations).toHaveLength(rawMatches.length);
    expect(result.stations[0].siteName).toBe(rawMatches[0].sitename);
  });

  it("transform re-filters client-side even though the fixture (like real MOENV traffic) returns all stations regardless of the requested filter", () => {
    const rawMatches = rawFixture.filter((r: any) => r.county === "臺北市");
    const result = airQualityEntry.transform(fixture, { county: "臺北市" });

    expect(result.stations).toHaveLength(rawMatches.length);
    expect(result.stations[0].siteName).toBe(rawMatches[0].sitename);
    expect(result.stations.every(s => s.county === "臺北市")).toBe(true);
  });

  it("transform throws NOT_FOUND for an unknown siteName", () => {
    try {
      airQualityEntry.transform(fixture, { siteName: "不存在站" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("NOT_FOUND");
      expect((error as ToolError).message).toContain("不存在站");
    }
  });

  it("transform throws NOT_FOUND when the county has no matching stations", () => {
    try {
      airQualityEntry.transform([], { county: "臺北市" });
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("NOT_FOUND");
      expect((error as ToolError).message).toContain("臺北市");
    }
  });

  it("transform warns when the raw record count meets the configured fetch limit", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fullPage = Array.from({ length: AQX_P_432_FETCH_LIMIT }, (_, i) => ({
      ...fixture[0],
      sitename: `站${i}`,
      county: "臺北市"
    }));

    airQualityEntry.transform(fullPage, { county: "臺北市" });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[air-quality]"));
    warnSpy.mockRestore();
  });

  it("transform does not warn on a normal, well-under-the-limit record count", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    airQualityEntry.transform(fixture, { county: "新北市" });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("maps MOENV's null-normalized missing values through to null, not 0, in the final shape", () => {
    // Inline, not the shared fixture above (which gets overwritten with
    // live data): this edge case needs guaranteed "" / "-" markers present
    // to be meaningful, which live hourly readings aren't guaranteed to have.
    const rawStationWithMissingValues = normalizeMoenvRecord({
      sitename: "測試站",
      county: "新北市",
      aqi: "50",
      pollutant: "",
      status: "普通",
      so2: "1",
      co: "0.1",
      o3: "-",
      o3_8hr: "10",
      pm10: "30",
      "pm2.5": "",
      no2: "5",
      nox: "6",
      no: "1",
      wind_speed: "1",
      wind_direc: "100",
      publishtime: "2026/01/01 00:00:00",
      co_8hr: "0.1",
      "pm2.5_avg": "10",
      pm10_avg: "25",
      so2_avg: "1",
      longitude: "121.5",
      latitude: "25.0",
      siteid: "999"
    });

    const result = airQualityEntry.transform([rawStationWithMissingValues], { county: "新北市" });
    const station = result.stations[0];

    expect(station.pm25).toBeNull();
    expect(station.o3).toBeNull();
    expect(station.mainPollutant).toBeNull();
    expect(station.pm10).toBe(30);
  });
});

describe("validateAirQualityParams", () => {
  // Also exercised indirectly via airQualityEntry.validateParams by
  // tw_query_dataset (test/tools/generic.test.ts) — this is the single
  // source of truth both that generic path and runAirQuality
  // (src/tools/air-quality.ts) call, so it's tested directly here too.
  it("is wired up as airQualityEntry's validateParams hook", () => {
    expect(airQualityEntry.validateParams).toBe(validateAirQualityParams);
  });

  it("rejects when neither county nor siteName is given", () => {
    expect(() => validateAirQualityParams({})).toThrow(ToolError);
    expect(() => validateAirQualityParams({})).toThrow(/擇一|其中一個/);
  });

  it("rejects when both county and siteName are given", () => {
    expect(() => validateAirQualityParams({ county: "新北市", siteName: "板橋" })).toThrow(/只能擇一/);
  });

  it("accepts county alone", () => {
    expect(() => validateAirQualityParams({ county: "新北市" })).not.toThrow();
  });

  it("accepts siteName alone", () => {
    expect(() => validateAirQualityParams({ siteName: "板橋" })).not.toThrow();
  });
});

describe("airQualityForecastEntry", () => {
  it("is registered under moenv:aqf_p_01 and matches the imported entry", () => {
    expect(getDatasetEntry("moenv:aqf_p_01")).toBe(airQualityForecastEntry);
  });

  it("transform returns every forecast area when no area filter is given", () => {
    const result = airQualityForecastEntry.transform(airQualityForecastFixture, {});
    expect(result.forecasts).toHaveLength(airQualityForecastFixture.length);
  });

  it("transform filters by area and maps fields to the compact shape", () => {
    const raw = airQualityForecastFixture.find((r: any) => r.Area === "北部");
    const result = airQualityForecastEntry.transform(airQualityForecastFixture, { area: "北部" });

    expect(result.query).toEqual({ area: "北部" });
    expect(result.forecasts).toHaveLength(1);
    expect(result.forecasts[0]).toEqual({
      area: raw.Area,
      forecastDate: raw.ForecastDate,
      aqi: raw.AQI,
      majorPollutant: raw.MajorPollutant,
      minorPollutant: raw.MinorPollutant,
      minorPollutantAqi: raw.MinorPollutantAQI,
      publishTime: raw.PublishTime,
      content: raw.Content
    });
  });

  it("maps MOENV's missing-value markers to null for minor pollutant fields", () => {
    const result = airQualityForecastEntry.transform(airQualityForecastFixture, { area: "高屏" });
    expect(result.forecasts[0].minorPollutant).toBeNull();
    expect(result.forecasts[0].minorPollutantAqi).toBeNull();
  });
});

describe("uvRealtimeEntry", () => {
  it("is registered under moenv:UV_S_01 and matches the imported entry", () => {
    expect(getDatasetEntry("moenv:UV_S_01")).toBe(uvRealtimeEntry);
  });

  it("transform returns every station when no county filter is given", () => {
    const result = uvRealtimeEntry.transform(uvRealtimeFixture, {});
    expect(result.stations).toHaveLength(uvRealtimeFixture.length);
  });

  it("transform filters by county and maps fields to the compact shape", () => {
    const raw = uvRealtimeFixture.find((r: any) => r.County === "臺北市");
    const result = uvRealtimeEntry.transform(uvRealtimeFixture, { county: "臺北市" });

    expect(result.query).toEqual({ county: "臺北市" });
    expect(result.stations).toHaveLength(1);
    expect(result.stations[0]).toEqual({
      siteName: raw.SiteName,
      uvi: Number(raw.Uvi),
      county: raw.County,
      dataTime: raw.DataCreationDate
    });
  });

  it("maps a missing Uvi value to null, not 0 or NaN", () => {
    const result = uvRealtimeEntry.transform(uvRealtimeFixture, { county: "南投縣" });
    expect(result.stations[0].uvi).toBeNull();
  });
});
