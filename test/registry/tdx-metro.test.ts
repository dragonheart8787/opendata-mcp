import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { metroAlertEntry, type TdxMetroAlertRawResponse } from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// Field structure confirmed 2026-07-22 via a real dispatch of
// fixtures-refresh.yml (Taipei/TRTC) — see the module comment on
// registry/tdx.ts. Unlike every other TDX entry in this project, the
// response is a single object (batch metadata + an `Alerts` array), not a
// bare array. TRTC was operating normally at capture time (one alert,
// Title/Description "正常營運"), so there's no real example of a genuine
// disruption record's shape.
const fixture: TdxMetroAlertRawResponse = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/metro-alert.json", import.meta.url)), "utf-8")
);

describe("metroAlertEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:metro-alert")).toBe(true);
  });

  it("maps the Chinese system name to TDX's systemId as the only path segment", () => {
    expect(metroAlertEntry.buildPathSegments?.({ system: "台北" })).toEqual(["TRTC"]);
    expect(metroAlertEntry.buildPathSegments?.({ system: "高雄" })).toEqual(["KRTC"]);
    expect(metroAlertEntry.buildPathSegments?.({ system: "桃園" })).toEqual(["TYMC"]);
  });

  it("always requests $format=JSON", () => {
    expect(metroAlertEntry.buildQueryParams({ system: "台北" })).toEqual({ $format: "JSON" });
  });

  it("transform surfaces systemId, updateTime, updateIntervalSeconds, and the real alerts array", () => {
    const result = metroAlertEntry.transform(fixture, { system: "台北" });
    expect(result.systemId).toBe("TRTC");
    expect(result.updateTime).toBe(fixture.UpdateTime);
    expect(result.updateIntervalSeconds).toBe(60);
    expect(result.alerts).toEqual(fixture.Alerts);
  });

  it("the real capture's Title/Description are plain text, not bilingual objects like StationName elsewhere", () => {
    const alert = fixture.Alerts![0];
    expect(typeof alert.Title).toBe("string");
    expect(typeof alert.Description).toBe("string");
    expect(alert.Title).toBe("正常營運");
  });

  it("handles a response with no Alerts array (defensive, not yet seen in a real capture)", () => {
    const result = metroAlertEntry.transform({ AuthorityCode: "TRTC", UpdateTime: "2026-01-01T00:00:00+08:00" }, { system: "台北" });
    expect(result.alerts).toEqual([]);
    expect(result.updateIntervalSeconds).toBeNull();
  });
});
