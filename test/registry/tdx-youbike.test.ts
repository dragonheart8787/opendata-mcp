import { describe, expect, it } from "vitest";
import { youBikeEntry } from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// SKELETON-stage tests only — youBikeEntry.transform is currently a
// pass-through (real field structure not yet confirmed against a live API
// response, see the module comment on registry/tdx.ts). Once a real
// fixtures-refresh.yml dispatch confirms the actual shape, this file should
// be rewritten the same way test/registry/tdx.test.ts's bus-eta entry was.

describe("youBikeEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:youbike")).toBe(true);
  });

  it("builds only the city as a path segment (no literal 'City/' prefix, unlike bus ETA)", () => {
    expect(youBikeEntry.buildPathSegments?.({ city: "Taipei" })).toEqual(["Taipei"]);
  });

  it("always requests $format=JSON regardless of params", () => {
    expect(youBikeEntry.buildQueryParams({ city: "Taipei" })).toEqual({ $format: "JSON" });
  });

  it("transform passes the raw array through, tagged with the query that produced it", () => {
    const raw = [{ StationName: "test" }];
    const result = youBikeEntry.transform(raw, { city: "Taipei", stationName: "test" });
    expect(result).toEqual({ query: { city: "Taipei", stationName: "test" }, raw });
  });
});
