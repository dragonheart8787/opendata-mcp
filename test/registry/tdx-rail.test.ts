import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  railTraLiveboardEntry,
  railTraStationEntry,
  type TdxRailTraLiveboardRawRecord,
  type TdxRailTraStationRawRecord
} from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// Both entries' field structures are confirmed 2026-07-22 via a real
// dispatch of fixtures-refresh.yml — see the module comment on
// registry/tdx.ts. The station fixture is a REAL but TRUNCATED capture (30
// of 245 nationwide stations kept, byte-verbatim per kept record) —
// shape-diff.ts only ever inspects an array's first element's structure
// (scripts/fixtures/shape-diff.ts's `shapeOf`), so array length has no
// bearing on drift detection. It deliberately keeps StationID "1000"
// (Taipei, used as railTraLiveboardEntry's sampleParams) plus at least one
// station missing StationAddress/StationPhone entirely, to exercise the
// optional fields. The liveboard fixture is the full real capture (only 8
// records for Taipei Station).
const stationFixture: TdxRailTraStationRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/rail-tra-station.json", import.meta.url)), "utf-8")
);
const liveboardFixture: TdxRailTraLiveboardRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/rail-tra-liveboard.json", import.meta.url)), "utf-8")
);

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

  it("transform passes the real fixture's records through as-is, wrapped", () => {
    expect(railTraStationEntry.transform(stationFixture, {})).toEqual({ stations: stationFixture });
  });

  it("includes Taipei Station (1000), matching railTraLiveboardEntry's sampleParams", () => {
    const taipei = stationFixture.find(s => s.StationID === "1000");
    expect(taipei?.StationName?.Zh_tw).toBe("臺北");
  });

  it("has at least one real record missing StationAddress/StationPhone — confirmed genuinely absent, not empty string, on unstaffed halts", () => {
    const withoutContactInfo = stationFixture.filter(s => s.StationAddress === undefined && s.StationPhone === undefined);
    expect(withoutContactInfo.length).toBeGreaterThan(0);
  });

  it("every record has StationID, a bilingual StationName, and numeric coordinates", () => {
    for (const record of stationFixture) {
      expect(typeof record.StationID).toBe("string");
      expect(typeof record.StationName?.Zh_tw).toBe("string");
      expect(typeof record.StationPosition?.PositionLat).toBe("number");
      expect(typeof record.StationPosition?.PositionLon).toBe("number");
    }
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

  it("transform passes through records that already match the requested StationID", () => {
    const result = railTraLiveboardEntry.transform(liveboardFixture, { stationId: "1000" });
    expect(result).toEqual({ trains: liveboardFixture });
  });

  it("re-filters client-side by StationID, dropping records for a different station (AGENTS.md §6 discipline)", () => {
    const mixed = [...liveboardFixture, { ...liveboardFixture[0], StationID: "0900", TrainNo: "999" }];
    const result = railTraLiveboardEntry.transform(mixed, { stationId: "1000" });
    expect(result.trains.length).toBe(liveboardFixture.length);
    expect(result.trains.every(t => t.StationID === "1000")).toBe(true);
  });

  it("the real fixture has no platform/月台 field on any record", () => {
    for (const record of liveboardFixture) {
      expect(record).not.toHaveProperty("Platform");
      expect(record).not.toHaveProperty("PlatformID");
    }
  });

  it("DelayTime is genuinely present as 0 (on time), not absent, when a train isn't delayed", () => {
    const onTime = liveboardFixture.filter(t => t.DelayTime === 0);
    expect(onTime.length).toBeGreaterThan(0);
  });

  it("includes a delayed train (DelayTime > 0) in the real capture", () => {
    expect(liveboardFixture.some(t => (t.DelayTime ?? 0) > 0)).toBe(true);
  });
});
