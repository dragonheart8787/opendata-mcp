import { describe, expect, it } from "vitest";
import { busEtaEntry, type TdxBusEtaRawRecord } from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";
import { BUS_ETA_MAX_STOPS_RETURNED } from "../../src/constants.js";

// Real field structure confirmed 2026-07-22 via a real dispatch of
// fixtures-refresh.yml against the live API — see the module comment on
// registry/tdx.ts for the full provenance note. These sample records are
// taken verbatim (unmodified field values) from that real capture, not
// hand-invented — see test/fixtures/bus-eta.json for the full committed
// fixture once the narrower per-route dispatch lands.
const withEstimate: TdxBusEtaRawRecord = {
  StopUID: "TPE36407",
  StopID: "36407",
  StopName: { Zh_tw: "榮總一", En: "Veterans General Hospital I" },
  RouteUID: "TPE10442",
  RouteID: "10442",
  RouteName: { Zh_tw: "508區", En: "508Shuttle" },
  Direction: 1,
  EstimateTime: 580,
  StopStatus: 0,
  SrcUpdateTime: "2026-07-22T11:10:30+08:00",
  UpdateTime: "2026-07-22T11:10:37+08:00"
};

const withoutEstimate: TdxBusEtaRawRecord = {
  StopUID: "TPE187095",
  StopID: "187095",
  StopName: { Zh_tw: "新莊高中", En: "Xinzhuang High School" },
  RouteUID: "TPE10471",
  RouteID: "10471",
  RouteName: { Zh_tw: "615", En: "615" },
  Direction: 1,
  StopStatus: 1,
  SrcUpdateTime: "2026-07-22T11:10:30+08:00",
  UpdateTime: "2026-07-22T11:10:37+08:00"
};

describe("busEtaEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:bus-eta")).toBe(true);
  });

  it("builds only the city as a path segment when routeName is omitted", () => {
    expect(busEtaEntry.buildPathSegments?.({ city: "Taipei" })).toEqual(["Taipei"]);
  });

  it("builds city + routeName as path segments when routeName is provided (server-side filter attempt)", () => {
    expect(busEtaEntry.buildPathSegments?.({ city: "Taipei", routeName: "615" })).toEqual(["Taipei", "615"]);
  });

  it("always requests $format=JSON regardless of params", () => {
    expect(busEtaEntry.buildQueryParams({ city: "Taipei" })).toEqual({ $format: "JSON" });
  });

  it("maps real fields onto the compact stop shape, including a record with no current estimate", () => {
    const result = busEtaEntry.transform([withEstimate, withoutEstimate], { city: "Taipei" });

    expect(result.totalMatched).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.stops).toEqual([
      {
        routeName: "508區",
        routeNameEn: "508Shuttle",
        stopName: "榮總一",
        stopNameEn: "Veterans General Hospital I",
        direction: 1,
        estimateSeconds: 580,
        stopStatusCode: 0,
        updateTime: "2026-07-22T11:10:37+08:00"
      },
      {
        routeName: "615",
        routeNameEn: "615",
        stopName: "新莊高中",
        stopNameEn: "Xinzhuang High School",
        direction: 1,
        estimateSeconds: null, // EstimateTime genuinely absent on the raw record — see module comment
        stopStatusCode: 1,
        updateTime: "2026-07-22T11:10:37+08:00"
      }
    ]);
  });

  it("client-side re-filters by routeName even when the upstream returns an unfiltered list (AGENTS.md §6)", () => {
    const result = busEtaEntry.transform([withEstimate, withoutEstimate], { city: "Taipei", routeName: "615" });
    expect(result.totalMatched).toBe(1);
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0].routeName).toBe("615");
  });

  it("client-side re-filters by stopName (English name also matches)", () => {
    const result = busEtaEntry.transform([withEstimate, withoutEstimate], {
      city: "Taipei",
      stopName: "Xinzhuang High School"
    });
    expect(result.totalMatched).toBe(1);
    expect(result.stops[0].stopName).toBe("新莊高中");
  });

  it("returns an empty (not thrown) result when nothing matches — not an error condition", () => {
    const result = busEtaEntry.transform([withEstimate], { city: "Taipei", routeName: "no-such-route" });
    expect(result.totalMatched).toBe(0);
    expect(result.stops).toEqual([]);
  });

  it("caps the returned stops and reports truncated: true when matches exceed the limit", () => {
    const many: TdxBusEtaRawRecord[] = Array.from({ length: BUS_ETA_MAX_STOPS_RETURNED + 10 }, (_, i) => ({
      ...withEstimate,
      StopUID: `TPE${i}`
    }));
    const result = busEtaEntry.transform(many, { city: "Taipei" });
    expect(result.totalMatched).toBe(BUS_ETA_MAX_STOPS_RETURNED + 10);
    expect(result.stops).toHaveLength(BUS_ETA_MAX_STOPS_RETURNED);
    expect(result.truncated).toBe(true);
  });
});
