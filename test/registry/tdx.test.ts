import { describe, expect, it } from "vitest";
import { busEtaEntry } from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// SKELETON-stage tests only — busEtaEntry.transform is currently a
// pass-through (real field structure not yet confirmed against a live API
// response, see the module comment on registry/tdx.ts). Once a real
// fixtures-refresh.yml dispatch confirms the actual shape, this file should
// be rewritten the same way test/registry/cwa.test.ts's typhoon entries
// were: fixture-driven tests asserting the real mapped fields, including a
// case where the upstream returns an unfiltered list (see AGENTS.md §6).

describe("busEtaEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:bus-eta")).toBe(true);
  });

  it("builds the city as a path segment, not a query param", () => {
    expect(busEtaEntry.buildPathSegments?.({ city: "Taipei", routeName: undefined, stopName: undefined })).toEqual([
      "Taipei"
    ]);
  });

  it("always requests $format=JSON regardless of params", () => {
    expect(busEtaEntry.buildQueryParams({ city: "Taipei" })).toEqual({ $format: "JSON" });
  });

  it("transform passes the raw array through, tagged with the query that produced it", () => {
    const raw = [{ RouteName: "307" }];
    const result = busEtaEntry.transform(raw, { city: "Taipei", routeName: "307", stopName: undefined });
    expect(result).toEqual({ query: { city: "Taipei", routeName: "307", stopName: undefined }, raw });
  });
});
