import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { roadTrafficCmsEntry, type TdxRoadTrafficCmsRawResponse } from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// Field structure confirmed 2026-07-23 via a real dispatch of
// fixtures-refresh.yml (Taipei, ~180 records, truncated here to 22
// representative ones — shape-diff.ts only ever inspects an array's first
// element, so length has no bearing on drift detection). Deliberately keeps
// a mix of records with and without RoadID/RoadName/RoadClass/RoadDirection
// (confirmed genuinely absent on some real records, e.g. minor links with
// no named road association), to exercise those optional fields.
//
// tdx:parking-offstreet-carpark is NOT tested here — it was investigated
// and deliberately not registered after two real dispatches (Taipei, New
// Taipei) both came back with an empty CarParks array, so no real
// per-record shape was ever observed. See registry/tdx.ts's comment where
// that entry used to be, and the PR, for the full story.
const fixture: TdxRoadTrafficCmsRawResponse = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/road-traffic-cms.json", import.meta.url)), "utf-8")
);

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

  it("transform surfaces authorityCode, updateTime, updateIntervalSeconds, and the real signs array", () => {
    const result = roadTrafficCmsEntry.transform(fixture, { city: "Taipei" });
    expect(result.authorityCode).toBe("TPE");
    expect(result.updateTime).toBe(fixture.UpdateTime);
    expect(result.updateIntervalSeconds).toBe(21600);
    expect(result.signs).toEqual(fixture.CMSs);
  });

  it("the real fixture has no message/display-text field on any record — this is a location inventory, not board content", () => {
    for (const sign of fixture.CMSs!) {
      expect(sign).not.toHaveProperty("Message");
      expect(sign).not.toHaveProperty("Content");
      expect(sign).not.toHaveProperty("DisplayText");
    }
  });

  it("has at least one real record missing RoadID/RoadName/RoadClass/RoadDirection — confirmed genuinely absent, not a fixture gap", () => {
    const withoutRoadInfo = fixture.CMSs!.filter(s => s.RoadID === undefined && s.RoadName === undefined);
    expect(withoutRoadInfo.length).toBeGreaterThan(0);
  });

  it("every record has CMSID, LinkID, LocationType, and numeric coordinates", () => {
    for (const sign of fixture.CMSs!) {
      expect(typeof sign.CMSID).toBe("string");
      expect(typeof sign.LinkID).toBe("string");
      expect(typeof sign.LocationType).toBe("number");
      expect(typeof sign.PositionLon).toBe("number");
      expect(typeof sign.PositionLat).toBe("number");
    }
  });

  it("handles a response with no CMSs array (defensive, not yet seen in a real capture)", () => {
    const result = roadTrafficCmsEntry.transform({ AuthorityCode: "TPE", UpdateTime: "2026-01-01T00:00:00+08:00" }, { city: "Taipei" });
    expect(result.signs).toEqual([]);
    expect(result.updateIntervalSeconds).toBeNull();
  });
});
