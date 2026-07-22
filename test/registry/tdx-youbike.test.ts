import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  youBikeAvailabilityEntry,
  youBikeStationEntry,
  type TdxBikeAvailabilityRawRecord,
  type TdxBikeStationRawRecord
} from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// Both entries' field structures are confirmed 2026-07-22 via real
// dispatches of fixtures-refresh.yml (Taipei, 1,775 stations each) — see
// the module comments on registry/tdx.ts. Both committed fixtures are REAL
// but TRUNCATED captures (byte-verbatim per kept record) — the full
// responses were ~652KB/~1.1MB, by far the largest in this repo, and
// shape-diff.ts only ever inspects an array's first element's structure
// (scripts/fixtures/shape-diff.ts's `shapeOf`), so array length has no
// bearing on future drift detection. The station fixture's 33 StationUIDs
// deliberately match the availability fixture's, plus 2 station-only
// records with no availability counterpart, to exercise the join.
const availabilityFixture: TdxBikeAvailabilityRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/youbike-availability.json", import.meta.url)), "utf-8")
);
const stationFixture: TdxBikeStationRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/youbike-station.json", import.meta.url)), "utf-8")
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
    const result = youBikeAvailabilityEntry.transform(availabilityFixture, { city: "Taipei" });
    expect(result).toEqual({ query: { city: "Taipei" }, stations: availabilityFixture });
  });

  it("the fixture has no station-name field anywhere — confirming the real gap that motivated youBikeStationEntry", () => {
    for (const record of availabilityFixture) {
      expect(record).not.toHaveProperty("StationName");
    }
  });

  it("includes both ServiceStatus values seen in the real capture", () => {
    const statuses = new Set(availabilityFixture.map(r => r.ServiceStatus));
    expect(statuses.has(1)).toBe(true);
    expect(statuses.has(0)).toBe(true);
  });
});

describe("youBikeStationEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:youbike-station")).toBe(true);
  });

  it("builds only the city as a path segment", () => {
    expect(youBikeStationEntry.buildPathSegments?.({ city: "Taipei" })).toEqual(["Taipei"]);
  });

  it("always requests $format=JSON regardless of params", () => {
    expect(youBikeStationEntry.buildQueryParams({ city: "Taipei" })).toEqual({ $format: "JSON" });
  });

  it("transform passes the real fixture's records through as-is, tagged with the query", () => {
    const result = youBikeStationEntry.transform(stationFixture, { city: "Taipei" });
    expect(result).toEqual({ query: { city: "Taipei" }, stations: stationFixture });
  });

  it("every record has a bilingual StationName and a numeric BikesCapacity — the fields Availability is missing", () => {
    for (const record of stationFixture) {
      expect(typeof record.StationName?.Zh_tw).toBe("string");
      expect(typeof record.BikesCapacity).toBe("number");
    }
  });

  it("shares StationUIDs with the availability fixture, enabling the join", () => {
    const availabilityUids = new Set(availabilityFixture.map(r => r.StationUID));
    const stationUids = new Set(stationFixture.map(r => r.StationUID));
    const overlap = [...availabilityUids].filter(uid => stationUids.has(uid));
    expect(overlap.length).toBe(availabilityFixture.length);
  });
});
