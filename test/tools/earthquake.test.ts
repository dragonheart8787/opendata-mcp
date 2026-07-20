import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatRecentEarthquakesText, runRecentEarthquakes } from "../../src/tools/earthquake.js";
import { jsonFetch } from "../helpers.js";

// This fixture is overwritten with a real, live API response whenever
// scripts/fixtures/refresh-fixtures.ts detects structural drift — so its
// specific earthquake content (numbers, dates, magnitudes) changes over
// time. Tests below assert against whatever is currently in the fixture
// rather than hardcoding literal values, so a routine refresh never breaks
// them on its own; only a genuine mapping bug should.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/earthquakes.json", import.meta.url)), "utf-8")
);
const rawEarthquakes: any[] = fixture.records.Earthquake;

describe("runRecentEarthquakes", () => {
  it("maps each raw earthquake's fields onto the correct summary fields", async () => {
    const result = await runRecentEarthquakes(rawEarthquakes.length, "test-key", jsonFetch(fixture));

    expect(result.earthquakes).toHaveLength(rawEarthquakes.length);
    result.earthquakes.forEach((eq, i) => {
      const raw = rawEarthquakes[i];
      expect(eq.earthquakeNo).toBe(raw.EarthquakeNo);
      expect(eq.originTime).toBe(raw.EarthquakeInfo.OriginTime);
      expect(eq.magnitude).toBe(raw.EarthquakeInfo.EarthquakeMagnitude.MagnitudeValue);
      expect(eq.magnitudeType).toBe(raw.EarthquakeInfo.EarthquakeMagnitude.MagnitudeType);
      expect(eq.depthKm).toBe(raw.EarthquakeInfo.FocalDepth);
      expect(eq.epicenter).toBe(raw.EarthquakeInfo.Epicenter.Location);
      expect(eq.reportContent).toBe(raw.ReportContent);
      expect(eq.detailUrl).toBe(raw.Web);
      expect(typeof eq.maxIntensity).toBe("string");
      expect(eq.maxIntensity.length).toBeGreaterThan(0);
    });
  });

  it("picks the strongest intensity across all shaking areas, not just the first one", async () => {
    // Deliberately inline, not the shared fixture above (which gets
    // overwritten with live data): this edge case needs a specific,
    // stable ordering — weakest area listed first — to prove the code
    // doesn't just take ShakingArea[0].
    const multiAreaEarthquake = {
      success: "true",
      records: {
        datasetDescription: "顯著有感地震報告",
        Earthquake: [
          {
            EarthquakeNo: 999999,
            ReportContent: "測試地震",
            Web: "https://example.com/999999",
            EarthquakeInfo: {
              OriginTime: "2026-01-01 00:00:00",
              FocalDepth: 10,
              Epicenter: { Location: "測試" },
              EarthquakeMagnitude: { MagnitudeType: "芮氏規模", MagnitudeValue: 3 }
            },
            Intensity: {
              ShakingArea: [
                { CountyName: "A", AreaIntensity: "1級" },
                { CountyName: "B", AreaIntensity: "4級" },
                { CountyName: "C", AreaIntensity: "2級" }
              ]
            }
          }
        ]
      }
    };

    const result = await runRecentEarthquakes(1, "test-key", jsonFetch(multiAreaEarthquake));
    expect(result.earthquakes[0].maxIntensity).toBe("4級");
  });

  it("respects the limit parameter", async () => {
    const result = await runRecentEarthquakes(1, "test-key", jsonFetch(fixture));
    expect(result.earthquakes).toHaveLength(1);
    expect(result.earthquakes[0].earthquakeNo).toBe(rawEarthquakes[0].EarthquakeNo);
  });

  it("propagates the missing-API-key error", async () => {
    await expect(runRecentEarthquakes(3, undefined)).rejects.toThrow(/CWA_API_KEY/);
  });
});

describe("formatRecentEarthquakesText", () => {
  it("renders a human-readable report including each earthquake's number, magnitude, and intensity label", async () => {
    const result = await runRecentEarthquakes(rawEarthquakes.length, "test-key", jsonFetch(fixture));
    const text = formatRecentEarthquakesText(result);

    for (const raw of rawEarthquakes) {
      expect(text).toContain(`No.${raw.EarthquakeNo}`);
      expect(text).toContain(`芮氏規模 ${raw.EarthquakeInfo.EarthquakeMagnitude.MagnitudeValue}`);
    }
    expect(text).toContain("最大震度：");
  });
});
