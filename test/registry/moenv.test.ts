import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AQX_P_432_FETCH_LIMIT } from "../../src/constants.js";
import { ToolError } from "../../src/infra/errors.js";
import { normalizeMoenvRecord } from "../../src/adapters/moenv.js";
import { airQualityEntry } from "../../src/registry/moenv.js";
import { getDatasetEntry } from "../../src/registry/index.js";

const rawFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/air-quality.json", import.meta.url)), "utf-8")
);
// Registry transforms receive already-normalized raw records (the adapter's job),
// so run the fixture through the same normalization the adapter applies.
const fixture = rawFixture.map(normalizeMoenvRecord);

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
    const result = airQualityEntry.transform(fixture, { county: "新北市" });
    expect(result.query).toEqual({ county: "新北市" });
    expect(result.stations).toHaveLength(2);
    expect(result.stations[0].siteName).toBe("板橋");
  });

  it("transform re-filters client-side even though the fixture (like real MOENV traffic) returns all stations regardless of the requested filter", () => {
    const result = airQualityEntry.transform(fixture, { county: "臺北市" });
    expect(result.stations).toHaveLength(1);
    expect(result.stations[0].siteName).toBe("士林");
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
    const result = airQualityEntry.transform(fixture, { county: "新北市" });
    const xinzhuang = result.stations.find(s => s.siteName === "新莊")!;
    expect(xinzhuang.pm25).toBeNull();
    expect(xinzhuang.o3).toBeNull();
    expect(xinzhuang.mainPollutant).toBeNull();
  });
});
