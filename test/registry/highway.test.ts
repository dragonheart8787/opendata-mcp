import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { highwayLiveEventsEntry, type HighwayLiveEventListRawResponse } from "../../src/registry/highway.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// Real structure confirmed 2026-07-23 via a real fetch of
// https://tisvcloud.freeway.gov.tw/history/motc20/LiveEvents.xml (deployed
// Cloudflare Worker — the only environment that could actually reach this
// host, see constants.ts's module comment on HIGHWAY_API_BASE_URL),
// re-parsed through this project's exact adapter parser config to get the
// real JS shape byte-for-byte, not a hand-guessed one. Kept to 5 of the
// real events (the response was ~99KB / far more records), deliberately
// preserving structural diversity: events 1-3 have Interchange+Ramp (an
// interchange-adjacent location), events 4-5 have SectionStart+SectionEnd
// instead (a plain road-segment location) — confirming those two shapes
// are genuinely mutually exclusive alternatives on real records, not a
// fixture gap.
const fixture: HighwayLiveEventListRawResponse = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/highway-live-events.json", import.meta.url)), "utf-8")
);

describe("highwayLiveEventsEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "highway:live-events")).toBe(true);
  });

  it("requests no query params — the feed is always the complete nationwide list", () => {
    expect(highwayLiveEventsEntry.buildQueryParams({})).toEqual({});
  });

  it("transform surfaces authorityCode, updateTime, and updateIntervalSeconds parsed from the real fixture", () => {
    const result = highwayLiveEventsEntry.transform(fixture, {});
    expect(result.authorityCode).toBe("NFB");
    expect(result.updateTime).toBe("2026-07-23T15:31:11+08:00");
    expect(result.updateIntervalSeconds).toBe(60);
  });

  it("maps every real event's human-readable text fields, WKT position, and opaque numeric-code passthroughs", () => {
    const result = highwayLiveEventsEntry.transform(fixture, {});
    expect(result.events).toHaveLength(5);

    const first = result.events[0];
    expect(first.eventId).toBe("A15040100H-01-20260723082311474100021");
    expect(first.title).toBe("施工事件");
    expect(first.description).toBe("國道三號 北向 54K+400 施工事件-施工維護");
    expect(first.impactDescription).toBe("部分阻斷交通");
    // opaque passthroughs — not translated into guessed severity labels
    expect(first.eventType).toBe("2");
    expect(first.eventSubType).toBe("298");
    expect(first.severity).toBe("1");
    expect(first.blockWay).toBe("1");
    // WKT "POINT(121.323905 24.938822)" -> { lon, lat }
    expect(first.position).toEqual({ lon: 121.323905, lat: 24.938822 });
    expect(first.road).toBe("國道三號");
    expect(first.direction).toBe("北向");
    expect(first.interchange).toBe("鶯歌系統");
  });

  it("has at least one real event with SectionStart/SectionEnd instead of Interchange — confirmed genuinely mutually exclusive, not a fixture gap", () => {
    const result = highwayLiveEventsEntry.transform(fixture, {});
    const sectionEvent = result.events.find(e => e.sectionStart !== null);
    expect(sectionEvent).toBeDefined();
    expect(sectionEvent!.interchange).toBeNull();
    expect(sectionEvent!.sectionStart).toBe("關西");
    expect(sectionEvent!.sectionEnd).toBe("寶山休息站");
  });

  it("filters client-side by road, partial-match, when the road param is given", () => {
    const result = highwayLiveEventsEntry.transform(fixture, { road: "國道一號" });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every(e => e.road === "國道一號")).toBe(true);
  });

  it("returns every event when no road filter is given", () => {
    const result = highwayLiveEventsEntry.transform(fixture, {});
    expect(result.events).toHaveLength(5);
  });

  it("returns an empty events array (not an error) when the filter matches nothing", () => {
    const result = highwayLiveEventsEntry.transform(fixture, { road: "國道九號" });
    expect(result.events).toEqual([]);
  });

  it("handles a response with no LiveEvents at all (defensive, not yet seen in a real capture)", () => {
    const result = highwayLiveEventsEntry.transform({ LiveEventList: { AuthorityCode: "NFB" } }, {});
    expect(result.events).toEqual([]);
    expect(result.updateIntervalSeconds).toBeNull();
  });

  it("rejects a WKT-shaped-but-malformed Positions string rather than guessing", () => {
    const malformed: HighwayLiveEventListRawResponse = {
      LiveEventList: {
        LiveEvents: { LiveEvent: [{ EventID: "X", Positions: "POINT(not-a-number 24.9)" }] }
      }
    };
    const result = highwayLiveEventsEntry.transform(malformed, {});
    expect(result.events[0].position).toBeNull();
  });
});
