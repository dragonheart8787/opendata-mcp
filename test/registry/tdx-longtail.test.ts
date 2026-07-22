import { describe, expect, it } from "vitest";
import { parkingOffStreetCarParkEntry, roadTrafficCmsEntry } from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// SKELETON-stage tests only — both entries' transforms are currently
// pass-throughs (real field structure not yet confirmed against a live API
// response, see the module comments on registry/tdx.ts). Once a real
// fixtures-refresh.yml dispatch confirms the actual shapes, this file
// should be rewritten the same way every prior skeleton→real transition in
// this project was (e.g. test/registry/tdx-metro.test.ts).

describe("parkingOffStreetCarParkEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:parking-offstreet-carpark")).toBe(true);
  });

  it("builds only the city as a path segment", () => {
    expect(parkingOffStreetCarParkEntry.buildPathSegments?.({ city: "Taipei" })).toEqual(["Taipei"]);
  });

  it("always requests $format=JSON", () => {
    expect(parkingOffStreetCarParkEntry.buildQueryParams({ city: "Taipei" })).toEqual({ $format: "JSON" });
  });

  it("transform passes the raw array through, tagged with the query", () => {
    const raw = [{ CarParkID: "TPE1", CarParkName: { Zh_tw: "測試停車場" } }];
    expect(parkingOffStreetCarParkEntry.transform(raw, { city: "Taipei" })).toEqual({
      query: { city: "Taipei" },
      carparks: raw
    });
  });
});

describe("roadTrafficCmsEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:road-traffic-cms")).toBe(true);
  });

  it("builds only the city as a path segment", () => {
    expect(roadTrafficCmsEntry.buildPathSegments?.({ city: "Taipei" })).toEqual(["Taipei"]);
  });

  it("always requests $format=JSON", () => {
    expect(roadTrafficCmsEntry.buildQueryParams({ city: "Taipei" })).toEqual({ $format: "JSON" });
  });

  it("transform passes the raw array through, tagged with the query", () => {
    const raw = [{ CMSID: "CMS001", Message: "前方施工" }];
    expect(roadTrafficCmsEntry.transform(raw, { city: "Taipei" })).toEqual({
      query: { city: "Taipei" },
      signs: raw
    });
  });
});
