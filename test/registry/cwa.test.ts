import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  recentEarthquakesEntry,
  stationObservationEntry,
  tideForecastEntry,
  typhoonNewsEntry,
  typhoonWarningEntry,
  uvDailyMaxEntry,
  weatherForecastEntry,
  weatherWarningEntry
} from "../../src/registry/cwa.js";
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
// Confirmed 2026-07-21 via a real dispatch of fixtures-refresh.yml against
// the live API (trimmed to 3 of the ~874 returned stations to keep the
// fixture small — see the module-level comment on stationObservationEntry,
// src/registry/cwa.ts, for the full provenance note, including why an
// earlier go-cwb-sourced version of this entry turned out stale).
const stationObservationFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/station-observation.json", import.meta.url)), "utf-8")
);
// Confirmed 2026-07-21 via a real dispatch of fixtures-refresh.yml against
// the live API (weather-warning.json trimmed to 3 of the 22 returned
// counties; uv-daily-max.json trimmed to 10 of the ~30 returned stations —
// see each entry's module-level comment in src/registry/cwa.ts).
const weatherWarningFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/weather-warning.json", import.meta.url)), "utf-8")
);
const uvDailyMaxFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/uv-daily-max.json", import.meta.url)), "utf-8")
);
// Confirmed 2026-07-21 via a real dispatch of fixtures-refresh.yml against
// the live API — see each entry's module-level comment in src/registry/
// cwa.ts for the full provenance note. typhoon-news.json's only tropical
// cyclone happened to still be an unnamed depression (no TyphoonName/
// CwaTyphoonName) at capture time — the "named typhoon" code path is
// exercised by an inline fixture below instead, since the live-refreshed
// fixture can't guarantee that field is ever present.
const typhoonNewsFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/typhoon-news.json", import.meta.url)), "utf-8")
);
const typhoonWarningFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/typhoon-warning.json", import.meta.url)), "utf-8")
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

describe("stationObservationEntry", () => {
  it("is registered under cwa:O-A0001-001 and matches the imported entry", () => {
    expect(getDatasetEntry("cwa:O-A0001-001")).toBe(stationObservationEntry);
  });

  it("buildQueryParams passes locationName through verbatim", () => {
    expect(stationObservationEntry.buildQueryParams({ locationName: "合歡山" })).toEqual({
      locationName: "合歡山"
    });
  });

  it("transform finds the requested station and passes weatherElement through", () => {
    const rawStation = stationObservationFixture.records.Station[0];
    const result = stationObservationEntry.transform(stationObservationFixture.records, {
      locationName: rawStation.StationName
    });

    expect(result.locationName).toBe(rawStation.StationName);
    expect(result.stationId).toBe(rawStation.StationId);
    expect(result.obsTime).toBe(rawStation.ObsTime.DateTime);
    expect(result.county).toBe(rawStation.GeoInfo.CountyName);
    expect(result.town).toBe(rawStation.GeoInfo.TownName);
    expect(result.weatherElement).toEqual(rawStation.WeatherElement);
  });

  it("transform re-filters client-side even though the fixture (like real CWA traffic) returns every station regardless of the requested locationName", () => {
    expect(stationObservationFixture.records.Station.length).toBeGreaterThan(1);
    const rawStation = stationObservationFixture.records.Station[1];
    const result = stationObservationEntry.transform(stationObservationFixture.records, {
      locationName: rawStation.StationName
    });

    expect(result.locationName).toBe(rawStation.StationName);
  });

  it("transform throws NOT_FOUND for a locationName not present in the response", () => {
    try {
      stationObservationEntry.transform(stationObservationFixture.records, { locationName: "不存在的測站" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("NOT_FOUND");
      expect((error as ToolError).message).toContain("不存在的測站");
    }
  });
});

describe("weatherWarningEntry", () => {
  it("is registered under cwa:W-C0033-001 and matches the imported entry", () => {
    expect(getDatasetEntry("cwa:W-C0033-001")).toBe(weatherWarningEntry);
  });

  it("buildQueryParams sends no query params (real dispatch confirmed an unfiltered fetch returns every county)", () => {
    expect(weatherWarningEntry.buildQueryParams({})).toEqual({});
  });

  it("transform returns every county when no county filter is given", () => {
    const result = weatherWarningEntry.transform(weatherWarningFixture.records, {});
    expect(result.counties).toHaveLength(weatherWarningFixture.records.location.length);
  });

  it("transform filters by county and maps hazards to the compact shape", () => {
    const raw = weatherWarningFixture.records.location.find((l: any) => l.hazardConditions.hazards.length > 0);
    const result = weatherWarningEntry.transform(weatherWarningFixture.records, { county: raw.locationName });

    expect(result.query).toEqual({ county: raw.locationName });
    expect(result.counties).toHaveLength(1);
    expect(result.counties[0]).toEqual({
      county: raw.locationName,
      hazards: raw.hazardConditions.hazards.map((h: any) => ({
        phenomena: h.info.phenomena,
        significance: h.info.significance,
        startTime: h.validTime.startTime,
        endTime: h.validTime.endTime
      }))
    });
  });

  it("transform returns an empty hazards array (not an error) for a county with no active warning", () => {
    const raw = weatherWarningFixture.records.location.find((l: any) => l.hazardConditions.hazards.length === 0);
    const result = weatherWarningEntry.transform(weatherWarningFixture.records, { county: raw.locationName });
    expect(result.counties[0].hazards).toEqual([]);
  });
});

describe("uvDailyMaxEntry", () => {
  it("is registered under cwa:O-A0005-001 and matches the imported entry", () => {
    expect(getDatasetEntry("cwa:O-A0005-001")).toBe(uvDailyMaxEntry);
  });

  it("buildQueryParams sends no query params (real dispatch confirmed an unfiltered fetch returns every station)", () => {
    expect(uvDailyMaxEntry.buildQueryParams({})).toEqual({});
  });

  it("transform returns every station and the response date when no stationId filter is given", () => {
    const result = uvDailyMaxEntry.transform(uvDailyMaxFixture.records, {});
    expect(result.date).toBe(uvDailyMaxFixture.records.weatherElement.Date);
    expect(result.stations).toHaveLength(uvDailyMaxFixture.records.weatherElement.location.length);
  });

  it("transform filters by stationId and maps fields to the compact shape", () => {
    const raw = uvDailyMaxFixture.records.weatherElement.location[0];
    const result = uvDailyMaxEntry.transform(uvDailyMaxFixture.records, { stationId: raw.StationID });

    expect(result.query).toEqual({ stationId: raw.StationID });
    expect(result.stations).toEqual([{ stationId: raw.StationID, uvIndex: raw.UVIndex }]);
  });
});

describe("typhoonNewsEntry", () => {
  it("is registered under cwa:W-C0034-005 and matches the imported entry", () => {
    expect(getDatasetEntry("cwa:W-C0034-005")).toBe(typhoonNewsEntry);
  });

  it("buildQueryParams sends no query params (real dispatch confirmed an unfiltered fetch returns every active system)", () => {
    expect(typhoonNewsEntry.buildQueryParams({})).toEqual({});
  });

  it("transform reports hasActiveSystem true and summarizes each tropical cyclone from the fixture", () => {
    const rawCyclone = typhoonNewsFixture.records.TropicalCyclones.TropicalCyclone[0];
    const rawAnalysisFixes = rawCyclone.AnalysisData.Fix;
    const rawLatestFix = rawAnalysisFixes[rawAnalysisFixes.length - 1];
    const rawForecastFixes = rawCyclone.ForecastData.Fix;

    const result = typhoonNewsEntry.transform(typhoonNewsFixture.records, {});

    expect(result.hasActiveSystem).toBe(true);
    expect(result.typhoons).toHaveLength(1);

    const typhoon = result.typhoons[0];

    // Deliberately NOT asserting "this system is an unnamed depression".
    // The fixture is a real capture, and the very same system can be
    // upgraded and named between refreshes — which is exactly what
    // happened (熱帶性低氣壓 14 became 颱風 白海豚/DOLPHIN, CwaTyNo 13) and
    // broke the previous hardcoded `CwaTdNo` / `isNamedTyphoon: false`
    // assertions. Named-vs-unnamed behavior is pinned by the hand-written
    // tests below instead; what this fixture test checks is faithful
    // transcription, which holds either way.
    expect(typhoon.cwaNumber).not.toBeNull();
    expect([rawCyclone.CwaTyNo, rawCyclone.CwaTdNo]).toContain(typhoon.cwaNumber);
    expect(typhoon.name).toBe(rawCyclone.CwaTyphoonName ?? null);
    expect(typhoon.internationalName).toBe(rawCyclone.TyphoonName ?? null);
    // Invariant rather than a fixed expectation: the flag must agree with
    // whether any name actually came through.
    expect(typhoon.isNamedTyphoon).toBe(typhoon.name !== null || typhoon.internationalName !== null);

    expect(typhoon.latestPosition).not.toBeNull();
    expect(typhoon.latestPosition!.time).toBe(rawLatestFix.DateTime);
    expect(typhoon.latestPosition!.latitude).toBe(Number(rawLatestFix.CoordinateLatitude));
    expect(typhoon.latestPosition!.longitude).toBe(Number(rawLatestFix.CoordinateLongitude));
    expect(typhoon.latestPosition!.maxWindSpeedMs).toBe(Number(rawLatestFix.MaxWindSpeed));

    expect(typhoon.forecastTrack).toHaveLength(rawForecastFixes.length);
    typhoon.forecastTrack.forEach((point, i) => {
      expect(point.time).toBe(rawForecastFixes[i].InitialTime);
      expect(point.forecastHour).toBe(Number(rawForecastFixes[i].ForecastHour));
      expect(point.latitude).toBe(Number(rawForecastFixes[i].CoordinateLatitude));
    });
  });

  it("transform reports hasActiveSystem false and an empty list when there are no active tropical cyclones", () => {
    const result = typhoonNewsEntry.transform({ TropicalCyclones: { TropicalCyclone: [] } }, {});
    expect(result.hasActiveSystem).toBe(false);
    expect(result.typhoons).toEqual([]);
  });

  it("transform surfaces name/internationalName and isNamedTyphoon true once CWA has named the system", () => {
    // Inline, not the shared fixture (which happened to capture an
    // unnamed depression) — this needs TyphoonName/CwaTyphoonName
    // guaranteed present, which the live-refreshed fixture can't promise.
    const namedTyphoonRaw = {
      TropicalCyclones: {
        TropicalCyclone: [
          {
            Year: "2026",
            CwaTyNo: "9",
            TyphoonName: "BAVI",
            CwaTyphoonName: "巴威",
            AnalysisData: {
              Fix: [
                {
                  DateTime: "2026-07-12T08:00:00+08:00",
                  CoordinateLongitude: "119.7",
                  CoordinateLatitude: "29.8",
                  MaxWindSpeed: "28",
                  MaxGustSpeed: "35",
                  Pressure: "980"
                }
              ]
            },
            ForecastData: { Fix: [] }
          }
        ]
      }
    };

    const result = typhoonNewsEntry.transform(namedTyphoonRaw, {});
    expect(result.typhoons[0].name).toBe("巴威");
    expect(result.typhoons[0].internationalName).toBe("BAVI");
    expect(result.typhoons[0].isNamedTyphoon).toBe(true);
    expect(result.typhoons[0].cwaNumber).toBe("9");
  });
});

describe("typhoonWarningEntry", () => {
  it("is registered under cwa:W-C0034-001 and matches the imported entry", () => {
    expect(getDatasetEntry("cwa:W-C0034-001")).toBe(typhoonWarningEntry);
  });

  it("buildQueryParams sends no query params (real dispatch confirmed an unfiltered fetch returns every bulletin)", () => {
    expect(typhoonWarningEntry.buildQueryParams({})).toEqual({});
  });

  it("transform maps each CAP alert to the compact bulletin shape", () => {
    const rawAlert = typhoonWarningFixture.records.info[0];
    const result = typhoonWarningEntry.transform(typhoonWarningFixture.records, {});

    expect(result.bulletins).toHaveLength(1);
    const bulletin = result.bulletins[0];
    expect(bulletin.headline).toBe(rawAlert.headline);
    expect(bulletin.event).toBe(rawAlert.event);
    expect(bulletin.urgency).toBe(rawAlert.urgency);
    expect(bulletin.severity).toBe(rawAlert.severity);
    expect(bulletin.certainty).toBe(rawAlert.certainty);
    expect(bulletin.effective).toBe(rawAlert.effective);
    expect(bulletin.onset).toBe(rawAlert.onset);
    expect(bulletin.expires).toBe(rawAlert.expires);
    expect(bulletin.senderName).toBe(rawAlert.senderName);
    expect(bulletin.webUrl).toBe(rawAlert.web);
    expect(bulletin.areas).toEqual(rawAlert.area.map((a: any) => a.areaDesc));
    expect(bulletin.description).toEqual(rawAlert.description);
  });

  it("transform returns an empty list (not an error) when there are no bulletins", () => {
    const result = typhoonWarningEntry.transform({ info: [] }, {});
    expect(result.bulletins).toEqual([]);
  });
});
