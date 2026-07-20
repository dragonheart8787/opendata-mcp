import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatRecentEarthquakesText, runRecentEarthquakes } from "../../src/tools/earthquake.js";
import { jsonFetch } from "../helpers.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/earthquakes.json", import.meta.url)), "utf-8")
);

describe("runRecentEarthquakes", () => {
  it("summarizes earthquakes into a compact structure", async () => {
    const result = await runRecentEarthquakes(2, "test-key", jsonFetch(fixture));

    expect(result.earthquakes).toHaveLength(2);
    expect(result.earthquakes[0]).toEqual({
      earthquakeNo: 114078,
      originTime: "2026-07-19 14:32:10",
      magnitude: 4.8,
      magnitudeType: "芮氏規模",
      depthKm: 15.0,
      epicenter: "花蓮縣政府東北東方 25.6 公里 (位於花蓮縣近海)",
      maxIntensity: "4級",
      reportContent: "07/19 14:32 花蓮縣近海 芮氏規模 4.8 地震，最大震度 4級 花蓮縣。",
      detailUrl: "https://scweb.cwa.gov.tw/zh-tw/earthquake/details/114078"
    });
  });

  it("picks the strongest intensity across all shaking areas, not just the first one", async () => {
    const result = await runRecentEarthquakes(1, "test-key", jsonFetch(fixture));
    // Fixture's first earthquake lists 花蓮縣=4級, 宜蘭縣=2級, 臺北市=1級 in that order.
    expect(result.earthquakes[0].maxIntensity).toBe("4級");
  });

  it("respects the limit parameter", async () => {
    const result = await runRecentEarthquakes(1, "test-key", jsonFetch(fixture));
    expect(result.earthquakes).toHaveLength(1);
    expect(result.earthquakes[0].earthquakeNo).toBe(114078);
  });

  it("propagates the missing-API-key error", async () => {
    await expect(runRecentEarthquakes(3, undefined)).rejects.toThrow(/CWA_API_KEY/);
  });
});

describe("formatRecentEarthquakesText", () => {
  it("renders a human-readable report including magnitude and intensity", async () => {
    const result = await runRecentEarthquakes(2, "test-key", jsonFetch(fixture));
    const text = formatRecentEarthquakesText(result);

    expect(text).toContain("No.114078");
    expect(text).toContain("芮氏規模 4.8");
    expect(text).toContain("最大震度：4級");
    expect(text).toContain("No.114077");
  });
});
