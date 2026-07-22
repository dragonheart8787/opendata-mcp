import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { busEtaEntry, type TdxBusEtaRawRecord } from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";
import { BUS_ETA_MAX_STOPS_RETURNED } from "../../src/constants.js";

// Real field structure confirmed 2026-07-22 via a real dispatch of
// fixtures-refresh.yml against the live API (Taipei, route 615) — see the
// module comment on registry/tdx.ts for the full provenance note,
// including the unfiltered-city capture (28,731 records / ~12.5MB) that
// first confirmed the shape before sampleParams was narrowed to a single
// route. This fixture is the real, narrower per-route response — TDX's
// routeName path segment turned out to genuinely filter server-side here
// (all 78 records are route 615), which `transform` still doesn't rely on
// (always re-filters client-side per AGENTS.md §6).
const fixture: TdxBusEtaRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/bus-eta.json", import.meta.url)), "utf-8")
);

// NOT `fixture[0]` — a real re-dispatch of fixtures-refresh.yml on
// 2026-07-22 found every record in the (fresh) route-615 capture now
// carries EstimateTime (buses were actually running that time), which
// would make an estimate-absent test built on fixture[0] silently stop
// covering that code path the moment the fixture was refreshed again.
// This record's field *values* are still verbatim from a genuine real
// capture (the earlier 2026-07-22 route-615 dispatch, which happened to
// catch zero live buses — StopStatus 1, no EstimateTime), just no longer
// tied to fixture array position — same rationale as `withEstimate` below,
// which was already hand-authored for the same reason.
const withoutEstimate: TdxBusEtaRawRecord = {
  StopUID: "TPE187095",
  StopID: "187095",
  StopName: { Zh_tw: "新莊高中", En: "Xinzhuang High School" },
  RouteUID: "TPE10471",
  RouteID: "10471",
  RouteName: { Zh_tw: "615", En: "615" },
  Direction: 1,
  StopStatus: 1,
  SrcUpdateTime: "2026-07-22T11:18:30+08:00",
  UpdateTime: "2026-07-22T11:18:32+08:00"
};

// This record's field *values* are verbatim from a real 2026-07-22
// dispatch (the unfiltered Taipei-wide capture used to first confirm the
// shape, before sampleParams was narrowed to route 615), used here only to
// exercise the estimateSeconds-present code path.
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

  it("maps the real fixture's fields onto the compact stop shape", () => {
    const result = busEtaEntry.transform(fixture, { city: "Taipei", routeName: "615" });

    expect(result.totalMatched).toBe(fixture.length);
    expect(result.truncated).toBe(false);
    expect(result.stops.every(s => s.routeName === "615")).toBe(true);
    expect(result.stops.every(s => typeof s.stopName === "string")).toBe(true);
    expect(result.stops.every(s => s.direction === 0 || s.direction === 1)).toBe(true);
  });

  it("maps a record with an estimate and one without, correctly", () => {
    const result = busEtaEntry.transform([withEstimate, withoutEstimate], { city: "Taipei" });
    const mappedWithEstimate = result.stops.find(s => s.estimateSeconds !== null);
    const mappedWithoutEstimate = result.stops.find(s => s.estimateSeconds === null);

    expect(mappedWithEstimate?.estimateSeconds).toBe(withEstimate.EstimateTime);
    expect(mappedWithoutEstimate?.stopStatusCode).toBe(withoutEstimate.StopStatus);
    expect(mappedWithoutEstimate?.estimateSeconds).toBeNull();
  });

  it("client-side re-filters by routeName even when the upstream returns an unfiltered list (AGENTS.md §6)", () => {
    // withEstimate is route "508區", withoutEstimate is route "615" — an
    // unfiltered mix of two different routes, as if the upstream routeName
    // path-segment filter hadn't actually narrowed anything.
    const result = busEtaEntry.transform([withEstimate, withoutEstimate], { city: "Taipei", routeName: "615" });
    expect(result.totalMatched).toBe(1);
    expect(result.stops[0].routeName).toBe("615");
  });

  it("client-side re-filters by stopName (English name also matches)", () => {
    const result = busEtaEntry.transform(fixture, {
      city: "Taipei",
      stopName: withoutEstimate.StopName!.En
    });
    expect(result.totalMatched).toBeGreaterThan(0);
    expect(result.stops.every(s => s.stopNameEn === withoutEstimate.StopName!.En)).toBe(true);
  });

  it("returns an empty (not thrown) result when nothing matches — not an error condition", () => {
    const result = busEtaEntry.transform(fixture, { city: "Taipei", routeName: "no-such-route" });
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
