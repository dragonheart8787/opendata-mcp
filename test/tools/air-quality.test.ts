import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AQX_P_432_FETCH_LIMIT } from "../../src/constants.js";
import { ToolError } from "../../src/infra/errors.js";
import { formatAirQualityText, runAirQuality } from "../../src/tools/air-quality.js";
import { jsonFetch } from "../helpers.js";

// This fixture is overwritten with a real, live response whenever
// scripts/fixtures/refresh-fixtures.ts detects structural drift — so its
// specific readings (AQI, PM2.5, etc.) change over time. Tests below derive
// expected values from the fixture's own raw fields rather than hardcoding
// literals, so a routine refresh never breaks them on its own.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/air-quality.json", import.meta.url)), "utf-8")
);

const MISSING_VALUE_MARKERS = new Set(["", "-", "ND"]);
function toNum(value: string): number | null {
  if (MISSING_VALUE_MARKERS.has(value)) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}
/** Mirrors summarizeStation's field mapping, so expectations track whatever is currently in the fixture. */
function expectedStation(raw: any) {
  return {
    siteName: raw.sitename,
    county: raw.county,
    aqi: toNum(raw.aqi),
    status: MISSING_VALUE_MARKERS.has(raw.status) ? "無資料" : raw.status,
    mainPollutant: MISSING_VALUE_MARKERS.has(raw.pollutant) ? null : raw.pollutant,
    pm25: toNum(raw["pm2.5"]),
    pm10: toNum(raw.pm10),
    o3: toNum(raw.o3),
    publishTime: raw.publishtime
  };
}

describe("runAirQuality", () => {
  it("summarizes all stations of a county into a compact structure matching the raw fixture", async () => {
    const result = await runAirQuality({ county: "新北市" }, "test-key", jsonFetch(fixture));
    const rawMatches = fixture.filter((r: any) => r.county === "新北市");

    expect(result.query).toEqual({ county: "新北市" });
    expect(result.stations).toHaveLength(rawMatches.length);
    result.stations.forEach((station, i) => {
      expect(station).toEqual(expectedStation(rawMatches[i]));
    });
  });

  it("maps MOENV's unavailable-value markers (empty string, '-') to null, not 0", async () => {
    // Inline, not the shared fixture above (which gets overwritten with
    // live data): this edge case needs guaranteed "" / "-" markers present
    // to be meaningful, which live hourly readings aren't guaranteed to have.
    const stationWithMissingValues = [
      {
        sitename: "測試站",
        county: "新北市",
        aqi: "50",
        pollutant: "",
        status: "普通",
        o3: "-",
        pm10: "30",
        "pm2.5": "",
        publishtime: "2026/01/01 00:00:00"
      }
    ];

    const result = await runAirQuality({ county: "新北市" }, "test-key", jsonFetch(stationWithMissingValues));
    const station = result.stations[0];

    expect(station.pm25).toBeNull();
    expect(station.o3).toBeNull();
    expect(station.mainPollutant).toBeNull();
    expect(station.pm10).toBe(30);
  });

  it("re-filters client-side even when the upstream ignores the filters param entirely", async () => {
    // Regression test for the production bug: MOENV returned the full,
    // unfiltered nationwide station list regardless of the `filters` query
    // param sent. The fixture always returns every county's stations — the
    // tool must still only return the requested county's.
    const result = await runAirQuality({ county: "臺北市" }, "test-key", jsonFetch(fixture));
    const rawMatches = fixture.filter((r: any) => r.county === "臺北市");

    expect(result.stations).toHaveLength(rawMatches.length);
    expect(result.stations.every(s => s.county === "臺北市")).toBe(true);
    result.stations.forEach((station, i) => {
      expect(station.siteName).toBe(rawMatches[i].sitename);
    });
  });

  it("builds a filters=county,EQ,{county} query param with the county actually requested", async () => {
    let requestedUrl = "";
    const capturingFetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await runAirQuality({ county: "臺北市" }, "test-key", capturingFetch);

    // Compare against the exact percent-encoding the runtime would produce
    // (URLSearchParams), not a hand-rolled encodeURIComponent guess.
    const expectedQueryFragment = new URLSearchParams({ filters: "county,EQ,臺北市" }).toString();
    expect(requestedUrl).toContain(expectedQueryFragment);
    expect(new URL(requestedUrl).searchParams.get("filters")).toBe("county,EQ,臺北市");
  });

  it("passes the MOENV filters syntax and api_key as query parameters for a county query", async () => {
    let requestedUrl = "";
    const capturingFetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await runAirQuality({ county: "新北市" }, "test-key", capturingFetch);

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("api_key")).toBe("test-key");
    expect(url.searchParams.get("filters")).toBe("county,EQ,新北市");
  });

  it("builds a filters=sitename,EQ,{siteName} query param for a station query", async () => {
    let requestedUrl = "";
    const capturingFetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await runAirQuality({ siteName: "板橋" }, "test-key", capturingFetch);

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("filters")).toBe("sitename,EQ,板橋");
  });

  it("warns when the fetched record count meets the configured limit (possible truncation)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fullPage = Array.from({ length: AQX_P_432_FETCH_LIMIT }, (_, i) => ({
      ...fixture[0],
      sitename: `站${i}`,
      county: "臺北市"
    }));

    await runAirQuality({ county: "臺北市" }, "test-key", jsonFetch(fullPage));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[air-quality]"));
    warnSpy.mockRestore();
  });

  it("does not warn on a normal, well-under-the-limit response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAirQuality({ county: "新北市" }, "test-key", jsonFetch(fixture));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("rejects a call with neither county nor siteName, with guidance", async () => {
    await expect(runAirQuality({}, "test-key", jsonFetch(fixture))).rejects.toThrow(ToolError);
    await expect(runAirQuality({}, "test-key", jsonFetch(fixture))).rejects.toThrow(/擇一|其中一個/);
  });

  it("rejects a call with both county and siteName", async () => {
    await expect(
      runAirQuality({ county: "新北市", siteName: "板橋" }, "test-key", jsonFetch(fixture))
    ).rejects.toThrow(/只能擇一/);
  });

  it("gives an actionable error for an unknown siteName", async () => {
    await expect(runAirQuality({ siteName: "不存在站" }, "test-key", jsonFetch(fixture))).rejects.toThrow(
      /不存在站/
    );
  });

  it("propagates the missing-API-key error with the signup URL", async () => {
    await expect(runAirQuality({ county: "新北市" }, undefined)).rejects.toThrow(/MOENV_API_KEY/);
    await expect(runAirQuality({ county: "新北市" }, undefined)).rejects.toThrow(/data\.moenv\.gov\.tw/);
  });

  it("surfaces an invalid-key message from the MOENV error envelope", async () => {
    const badKeyFetch = jsonFetch({ message: "api_key is not valid" });
    await expect(runAirQuality({ county: "新北市" }, "bad-key", badKeyFetch)).rejects.toThrow(
      /data\.moenv\.gov\.tw/
    );
  });
});

describe("formatAirQualityText", () => {
  it("renders a human-readable summary with AQI and status", async () => {
    const result = await runAirQuality({ county: "新北市" }, "test-key", jsonFetch(fixture));
    const text = formatAirQualityText(result);
    const station = result.stations[0];

    expect(text).toContain("新北市 空氣品質");
    expect(text).toContain(station.siteName);
    expect(text).toContain(`AQI：${station.aqi ?? "無資料"}（${station.status}）`);
  });
});
