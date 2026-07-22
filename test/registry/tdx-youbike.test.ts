import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { youBikeAvailabilityEntry, youBikeStationEntry, type TdxBikeAvailabilityRawRecord } from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// youBikeAvailabilityEntry's field structure is confirmed 2026-07-22 via a
// real dispatch of fixtures-refresh.yml (Taipei, 1,775 stations) — see the
// module comment on registry/tdx.ts. The committed fixture is a REAL but
// TRUNCATED capture (33 of 1,775 records — 30 ServiceStatus=1 + 3
// ServiceStatus=0, byte-verbatim per kept record) — the full response was
// ~652KB, by far the largest in this repo, and shape-diff.ts only ever
// inspects an array's first element's structure (scripts/fixtures/
// shape-diff.ts's `shapeOf`), so array length has no bearing on future
// drift detection. youBikeStationEntry is still a SKELETON (pass-through
// transform) pending its own real dispatch.
const fixture: TdxBikeAvailabilityRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/youbike-availability.json", import.meta.url)), "utf-8")
);

describe("youBikeAvailabilityEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:youbike-availability")).toBe(true);
  });

  it("builds only the city as a path segment", () => {
    expect(youBikeAvailabilityEntry.buildPathSegments?.({ city: "Taipei" })).toEqual(["Taipei"]);
  });

  it("always requests $format=JSON regardless of params", () => {
    expect(youBikeAvailabilityEntry.buildQueryParams({ city: "Taipei" })).toEqual({ $format: "JSON" });
  });

  it("transform passes the real fixture's records through as-is, tagged with the query", () => {
    const result = youBikeAvailabilityEntry.transform(fixture, { city: "Taipei" });
    expect(result).toEqual({ query: { city: "Taipei" }, stations: fixture });
  });

  it("the fixture has no station-name field anywhere — confirming the real gap that motivated youBikeStationEntry", () => {
    for (const record of fixture) {
      expect(record).not.toHaveProperty("StationName");
    }
  });

  it("includes both ServiceStatus values seen in the real capture", () => {
    const statuses = new Set(fixture.map(r => r.ServiceStatus));
    expect(statuses.has(1)).toBe(true);
    expect(statuses.has(0)).toBe(true);
  });
});

describe("youBikeStationEntry (skeleton)", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:youbike-station")).toBe(true);
  });

  it("builds only the city as a path segment", () => {
    expect(youBikeStationEntry.buildPathSegments?.({ city: "Taipei" })).toEqual(["Taipei"]);
  });

  it("transform passes the raw array through, tagged with the query that produced it", () => {
    const raw = [{ StationName: "test" }];
    const result = youBikeStationEntry.transform(raw, { city: "Taipei" });
    expect(result).toEqual({ query: { city: "Taipei" }, raw });
  });
});
