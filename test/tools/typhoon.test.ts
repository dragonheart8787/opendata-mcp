import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatTyphoonText, runTyphoon } from "../../src/tools/typhoon.js";
import { jsonFetch } from "../helpers.js";

// Confirmed 2026-07-21 via a real dispatch of fixtures-refresh.yml against
// the live API — see the module-level comment on typhoonNewsEntry
// (src/registry/cwa.ts) for the full provenance note. The one tropical
// cyclone in this fixture happened to still be an unnamed depression at
// capture time.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/typhoon-news.json", import.meta.url)), "utf-8")
);
const rawCyclone = fixture.records.TropicalCyclones.TropicalCyclone[0];

describe("runTyphoon", () => {
  it("maps the fixture's tropical cyclone onto the compact summary shape", async () => {
    const result = await runTyphoon("test-key", jsonFetch(fixture));

    expect(result.hasActiveSystem).toBe(true);
    expect(result.typhoons).toHaveLength(1);
    expect(result.typhoons[0].cwaNumber).toBe(rawCyclone.CwaTdNo);
    expect(result.typhoons[0].isNamedTyphoon).toBe(false);
  });

  it("reports hasActiveSystem false when there are no active tropical cyclones", async () => {
    const noCyclones = { success: "true", records: { TropicalCyclones: { TropicalCyclone: [] } } };
    const result = await runTyphoon("test-key", jsonFetch(noCyclones));
    expect(result.hasActiveSystem).toBe(false);
    expect(result.typhoons).toEqual([]);
  });

  it("propagates the missing-API-key error", async () => {
    await expect(runTyphoon(undefined)).rejects.toThrow(/CWA_API_KEY/);
  });
});

describe("formatTyphoonText", () => {
  it("reports no active system in plain language when hasActiveSystem is false", () => {
    const text = formatTyphoonText({ hasActiveSystem: false, typhoons: [] });
    expect(text).toContain("沒有");
  });

  it("renders an unnamed depression's number and latest position without claiming it's a named typhoon", async () => {
    const result = await runTyphoon("test-key", jsonFetch(fixture));
    const text = formatTyphoonText(result);

    expect(text).toContain(rawCyclone.CwaTdNo);
    expect(text).toContain("尚未達颱風強度或未命名");
    expect(text).toContain("轉載自中央氣象署");
  });

  it("labels the latest analysis time as the report's 發布時間", async () => {
    const result = await runTyphoon("test-key", jsonFetch(fixture));
    const text = formatTyphoonText(result);
    const fixes = rawCyclone.AnalysisData.Fix;
    const latestDateTime = fixes[fixes.length - 1].DateTime;

    expect(text).toContain("發布時間");
    expect(text).toContain(latestDateTime);
  });

  it("renders a named typhoon's Chinese and international names", () => {
    const text = formatTyphoonText({
      hasActiveSystem: true,
      typhoons: [
        {
          name: "巴威",
          internationalName: "BAVI",
          isNamedTyphoon: true,
          cwaNumber: "9",
          latestPosition: {
            time: "2026-07-12T08:00:00+08:00",
            longitude: 119.7,
            latitude: 29.8,
            maxWindSpeedMs: 28,
            maxGustSpeedMs: 35,
            pressureHpa: 980
          },
          forecastTrack: []
        }
      ]
    });

    expect(text).toContain("巴威");
    expect(text).toContain("BAVI");
    expect(text).not.toContain("尚未達颱風強度或未命名");
  });
});
