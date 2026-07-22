import { describe, expect, it } from "vitest";
import { railTraLiveboardEntry, railTraStationEntry } from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// SKELETON-stage tests only — both entries' transforms are currently
// pass-throughs (real field structure not yet confirmed against a live API
// response, see the module comment on registry/tdx.ts). Once a real
// fixtures-refresh.yml dispatch confirms the actual shapes, this file
// should be rewritten the same way test/registry/tdx-youbike.test.ts's
// entries were: fixture-driven tests asserting the real mapped fields.

describe("railTraStationEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:rail-tra-station")).toBe(true);
  });

  it("has no path segments (single nationwide list)", () => {
    expect(railTraStationEntry.buildPathSegments).toBeUndefined();
  });

  it("always requests $format=JSON", () => {
    expect(railTraStationEntry.buildQueryParams({})).toEqual({ $format: "JSON" });
  });

  it("transform passes the raw array through, wrapped", () => {
    const raw = [{ StationID: "1000", StationName: "臺北" }];
    expect(railTraStationEntry.transform(raw, {})).toEqual({ stations: raw });
  });
});

describe("railTraLiveboardEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:rail-tra-liveboard")).toBe(true);
  });

  it("builds StationID as the only path segment", () => {
    expect(railTraLiveboardEntry.buildPathSegments?.({ stationId: "1000" })).toEqual(["1000"]);
  });

  it("always requests $format=JSON", () => {
    expect(railTraLiveboardEntry.buildQueryParams({ stationId: "1000" })).toEqual({ $format: "JSON" });
  });

  it("transform passes the raw array through, wrapped", () => {
    const raw = [{ TrainNo: "123" }];
    expect(railTraLiveboardEntry.transform(raw, { stationId: "1000" })).toEqual({ trains: raw });
  });
});
