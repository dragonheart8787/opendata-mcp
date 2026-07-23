import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatHighwayTrafficText, handleHighwayTrafficTool, runHighwayTraffic } from "../../src/tools/highway.js";
import type { HighwayLiveEventListRawResponse } from "../../src/registry/highway.js";
import { rejectingFetch, textFetch } from "../helpers.js";

const fixtureRaw: HighwayLiveEventListRawResponse = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/highway-live-events.json", import.meta.url)), "utf-8")
);

// The adapter parses XML text, so tool-level tests need a real XML string
// to feed through textFetch — reusing the fixture's own real values keeps
// this in sync with the actual captured structure instead of a
// hand-written XML string that could drift from it silently.
const SAMPLE_XML = `<LiveEventList>
<UpdateTime>${fixtureRaw.LiveEventList!.UpdateTime}</UpdateTime>
<UpdateInterval>${fixtureRaw.LiveEventList!.UpdateInterval}</UpdateInterval>
<AuthorityCode>${fixtureRaw.LiveEventList!.AuthorityCode}</AuthorityCode>
<LiveEvents>
  <LiveEvent>
    <EventID>${fixtureRaw.LiveEventList!.LiveEvents!.LiveEvent![0].EventID}</EventID>
    <EventTitle>${fixtureRaw.LiveEventList!.LiveEvents!.LiveEvent![0].EventTitle}</EventTitle>
    <Description>${fixtureRaw.LiveEventList!.LiveEvents!.LiveEvent![0].Description}</Description>
    <Impact><Description>部分阻斷交通</Description></Impact>
  </LiveEvent>
</LiveEvents>
</LiveEventList>`;

describe("runHighwayTraffic", () => {
  it("fetches (no auth needed) and transforms the real feed shape", async () => {
    const result = await runHighwayTraffic({}, {}, textFetch(SAMPLE_XML));
    expect(result.authorityCode).toBe("NFB");
    expect(result.updateIntervalSeconds).toBe(60);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe("施工事件");
  });

  it("propagates a real upstream failure", async () => {
    await expect(runHighwayTraffic({}, {}, textFetch("error", { status: 500 }))).rejects.toThrow();
  });

  it("propagates a network failure", async () => {
    await expect(runHighwayTraffic({}, {}, rejectingFetch(new Error("network down")))).rejects.toThrow(/network down/);
  });

  it("handleHighwayTrafficTool returns a successful MCP result on the happy path", async () => {
    const result = await handleHighwayTrafficTool({}, {}, textFetch(SAMPLE_XML));
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { ok?: boolean }).ok).toBe(true);
    expect(result.content[0]?.text).toContain("施工事件");
    expect(result.content[0]?.text).toContain("60 秒");
  });

  it("handleHighwayTrafficTool returns an error MCP result on upstream failure", async () => {
    const result = await handleHighwayTrafficTool({}, {}, textFetch("down", { status: 500 }));
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { ok?: boolean }).ok).toBe(false);
  });
});

describe("formatHighwayTrafficText", () => {
  it("relays title/description/impact verbatim, road/direction/KM location, update time, and the self-reported interval", () => {
    const text = formatHighwayTrafficText({
      query: {},
      authorityCode: "NFB",
      updateTime: "2026-07-23T15:31:11+08:00",
      updateIntervalSeconds: 60,
      events: [
        {
          eventId: "E1",
          title: "施工事件",
          description: "國道三號 北向 54K+400 施工事件-施工維護",
          eventType: "2",
          eventSubType: "298",
          effectiveTime: "2026-07-23T08:23:00+08:00",
          position: { lon: 121.323905, lat: 24.938822 },
          road: "國道三號",
          direction: "北向",
          startKm: "54K+400",
          endKm: "54K+400",
          interchange: "鶯歌系統",
          sectionStart: null,
          sectionEnd: null,
          impactDescription: "部分阻斷交通",
          severity: "1",
          blockWay: "1",
          blockedLanes: "RS",
          publishTime: "2026-07-23T08:23:00+08:00",
          lastUpdateTime: "2026-07-23T08:23:00+08:00"
        }
      ]
    });

    expect(text).toContain("施工事件");
    expect(text).toContain("國道三號");
    expect(text).toContain("部分阻斷交通");
    expect(text).toContain("2026-07-23T15:31:11+08:00");
    expect(text).toContain("60 秒");
  });

  it("shows the road filter in the heading when one was given", () => {
    const text = formatHighwayTrafficText({
      query: { road: "國道一號" },
      authorityCode: "NFB",
      updateTime: null,
      updateIntervalSeconds: null,
      events: []
    });
    expect(text).toContain("國道一號");
  });

  it("reports no matching events in plain language, not as certainty of a clear road", () => {
    const text = formatHighwayTrafficText({
      query: {},
      authorityCode: "NFB",
      updateTime: null,
      updateIntervalSeconds: null,
      events: []
    });
    expect(text).toContain("查無");
    expect(text).toContain("不代表本伺服器查詢失敗");
  });
});
