import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatRailText, handleRailTool, runRail } from "../../src/tools/rail.js";
import type { TdxRailTraLiveboardRawRecord, TdxRailTraStationRawRecord } from "../../src/registry/tdx.js";
import { RAIL_LIVEBOARD_DELAY_NOTICE } from "../../src/constants.js";

const stationFixture: TdxRailTraStationRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/rail-tra-station.json", import.meta.url)), "utf-8")
);
const liveboardFixture: TdxRailTraLiveboardRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/rail-tra-liveboard.json", import.meta.url)), "utf-8")
);

const TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

function tokenThenDataFetch(stations: unknown[], trains: unknown[]): typeof fetch {
  return (async (url: string) => {
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("LiveBoard")) {
      return new Response(JSON.stringify(trains), { status: 200 });
    }
    return new Response(JSON.stringify(stations), { status: 200 });
  }) as unknown as typeof fetch;
}

/** Boundary case: station list succeeds, LiveBoard itself fails — this must fail the whole call, no degrade (unlike tw_youbike's asymmetric join). */
function fetchWithLiveboardFailure(stations: unknown[]): typeof fetch {
  return (async (url: string) => {
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("LiveBoard")) {
      return new Response("liveboard endpoint down", { status: 500 });
    }
    return new Response(JSON.stringify(stations), { status: 200 });
  }) as unknown as typeof fetch;
}

/** The reverse boundary case: the station list itself fails — no StationID can be resolved, so this must fail even though LiveBoard would have succeeded. */
function fetchWithStationFailure(): typeof fetch {
  return (async (url: string) => {
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("LiveBoard")) {
      return new Response(JSON.stringify(liveboardFixture), { status: 200 });
    }
    return new Response("station endpoint down", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("runRail", () => {
  it("resolves an exact station name to a StationID and returns that station's real trains", async () => {
    const result = await runRail(
      { stationName: "臺北" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(stationFixture, liveboardFixture)
    );

    expect(result.station.stationId).toBe("1000");
    expect(result.totalMatched).toBe(liveboardFixture.length);
    expect(result.trains[0].trainNo).toBe(liveboardFixture[0].TrainNo);
    expect(result.trains[0].delayMinutes).toBe(liveboardFixture[0].DelayTime);
    expect(result.dataUpdateTime).toBe(liveboardFixture[0].UpdateTime);
    // The ~2-minute-delay disclosure must be part of the returned DATA
    // itself (not only the tool description or formatted text) — this is
    // what a caller reading structuredContent/data actually sees, and this
    // was previously missing from that representation entirely.
    expect(result.delayNotice).toContain("2 分鐘延遲");
    expect(result.delayNotice).toContain("車站月台顯示為準");
  });

  it("resolves a unique substring match that isn't any station's full name", async () => {
    const target = stationFixture.find(s => s.StationID === "1998");
    expect(target?.StationName?.Zh_tw).toBe("樹林調車場");
    const result = await runRail(
      { stationName: "調車場" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(stationFixture, [{ ...liveboardFixture[0], StationID: "1998" }])
    );
    expect(result.station.stationId).toBe("1998");
  });

  it("throws NOT_FOUND for a station name matching nothing", async () => {
    await expect(
      runRail(
        { stationName: "不存在的車站名稱XYZ" },
        { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
        tokenThenDataFetch(stationFixture, liveboardFixture)
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws an ambiguous INVALID_PARAMS error listing candidates when a substring matches multiple stations", async () => {
    const ambiguousStations = [
      { StationID: "0001", StationName: { Zh_tw: "測試站甲", En: "Test Station A" } },
      { StationID: "0002", StationName: { Zh_tw: "測試站乙", En: "Test Station B" } }
    ];
    await expect(
      runRail(
        { stationName: "測試站" },
        { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
        tokenThenDataFetch(ambiguousStations, [])
      )
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("filters by destinationStationName substring against EndingStationName", async () => {
    const targetDestination = liveboardFixture[0].EndingStationName!.Zh_tw!;
    const result = await runRail(
      { stationName: "臺北", destinationStationName: targetDestination },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(stationFixture, liveboardFixture)
    );
    expect(result.totalMatched).toBeGreaterThan(0);
    expect(result.trains.every(t => t.endingStationName?.includes(targetDestination))).toBe(true);
  });

  it("reports zero matches (not an error) when destinationStationName matches no train", async () => {
    const result = await runRail(
      { stationName: "臺北", destinationStationName: "不存在的終點站XYZ" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(stationFixture, liveboardFixture)
    );
    expect(result.totalMatched).toBe(0);
    expect(result.trains).toEqual([]);
    // Zero matches is still a real, non-error response carrying real data
    // (the resolved station) — the delay notice must still be present.
    expect(result.delayNotice).toContain("2 分鐘延遲");
  });

  it("propagates the missing-credentials error", async () => {
    await expect(
      runRail({ stationName: "臺北" }, { TDX_CLIENT_ID: undefined, TDX_CLIENT_SECRET: undefined })
    ).rejects.toThrow(/tdx\.transportdata\.tw/);
  });

  describe("sequential-dependency failure semantics (not tw_youbike's optional-enrichment join)", () => {
    it("fails the whole call when LiveBoard fails, even though the station list resolved fine", async () => {
      await expect(
        runRail(
          { stationName: "臺北" },
          { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
          fetchWithLiveboardFailure(stationFixture)
        )
      ).rejects.toThrow();
    });

    it("fails the whole call when the station list fails, even though LiveBoard would have succeeded", async () => {
      await expect(
        runRail({ stationName: "臺北" }, { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" }, fetchWithStationFailure())
      ).rejects.toThrow();
    });

    it("handleRailTool returns an error MCP result when LiveBoard fails", async () => {
      const result = await handleRailTool(
        { stationName: "臺北" },
        { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
        fetchWithLiveboardFailure(stationFixture)
      );
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { ok?: boolean }).ok).toBe(false);
    });

    it("handleRailTool returns a successful MCP result on the happy path", async () => {
      const result = await handleRailTool(
        { stationName: "臺北" },
        { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
        tokenThenDataFetch(stationFixture, liveboardFixture)
      );
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { ok?: boolean }).ok).toBe(true);
      expect(result.content[0]?.text).toContain("2 分鐘延遲");
    });
  });
});

describe("formatRailText", () => {
  it("renders train number, destination, times, delay, and the mandatory 2-minute-delay caveat", () => {
    const text = formatRailText({
      query: { stationName: "臺北" },
      station: { stationId: "1000", stationName: "臺北", stationNameEn: "Taipei" },
      trains: [
        {
          trainNo: "221",
          trainTypeName: "自強",
          trainTypeNameEn: "Tze-Chiang Express",
          direction: 1,
          endingStationName: "樹林",
          endingStationNameEn: "Shulin",
          scheduledArrivalTime: "15:45:00",
          scheduledDepartureTime: "15:48:00",
          delayMinutes: 1
        }
      ],
      totalMatched: 1,
      truncated: false,
      dataUpdateTime: "2026-07-22T15:42:04+08:00",
      delayNotice: RAIL_LIVEBOARD_DELAY_NOTICE
    });

    expect(text).toContain("221");
    expect(text).toContain("樹林");
    expect(text).toContain("15:45:00");
    expect(text).toContain("誤點約 1 分鐘");
    expect(text).toContain("2 分鐘延遲");
    expect(text).toContain("車站月台顯示為準");
  });

  it("puts the delay notice at the very start of the text, not just trailing after the train list", () => {
    const text = formatRailText({
      query: { stationName: "臺北" },
      station: { stationId: "1000", stationName: "臺北", stationNameEn: "Taipei" },
      trains: [
        {
          trainNo: "221",
          trainTypeName: "自強",
          trainTypeNameEn: "Tze-Chiang Express",
          direction: 1,
          endingStationName: "樹林",
          endingStationNameEn: "Shulin",
          scheduledArrivalTime: "15:45:00",
          scheduledDepartureTime: "15:48:00",
          delayMinutes: 1
        }
      ],
      totalMatched: 1,
      truncated: false,
      dataUpdateTime: "2026-07-22T15:42:04+08:00",
      delayNotice: RAIL_LIVEBOARD_DELAY_NOTICE
    });
    expect(text.startsWith(RAIL_LIVEBOARD_DELAY_NOTICE)).toBe(true);
  });

  it("shows 準點 (on time) when delayMinutes is 0, not blank", () => {
    const text = formatRailText({
      query: { stationName: "臺北" },
      station: { stationId: "1000", stationName: "臺北", stationNameEn: "Taipei" },
      trains: [
        {
          trainNo: "172",
          trainTypeName: "自強",
          trainTypeNameEn: null,
          direction: 0,
          endingStationName: "七堵",
          endingStationNameEn: null,
          scheduledArrivalTime: "15:46:00",
          scheduledDepartureTime: "15:49:00",
          delayMinutes: 0
        }
      ],
      totalMatched: 1,
      truncated: false,
      dataUpdateTime: "2026-07-22T15:42:04+08:00",
      delayNotice: RAIL_LIVEBOARD_DELAY_NOTICE
    });
    expect(text).toContain("準點");
  });

  it("reports zero matches in plain language, not as an error, and still includes the delay notice", () => {
    const text = formatRailText({
      query: { stationName: "臺北", destinationStationName: "不存在" },
      station: { stationId: "1000", stationName: "臺北", stationNameEn: "Taipei" },
      trains: [],
      totalMatched: 0,
      truncated: false,
      dataUpdateTime: null,
      delayNotice: RAIL_LIVEBOARD_DELAY_NOTICE
    });
    expect(text).toContain("查無");
    expect(text).toContain("不代表本伺服器查詢失敗");
    // The zero-match case is exactly the branch that previously skipped the
    // notice entirely — must not regress.
    expect(text).toContain("2 分鐘延遲");
  });

  it("warns when the result was truncated", () => {
    const manyTrains = Array.from({ length: 3 }, (_, i) => ({
      trainNo: `${i}`,
      trainTypeName: "區間",
      trainTypeNameEn: null,
      direction: 0,
      endingStationName: "基隆",
      endingStationNameEn: null,
      scheduledArrivalTime: "16:00:00",
      scheduledDepartureTime: "16:01:00",
      delayMinutes: 0
    }));
    const text = formatRailText({
      query: { stationName: "臺北" },
      station: { stationId: "1000", stationName: "臺北", stationNameEn: "Taipei" },
      trains: manyTrains,
      totalMatched: 200,
      truncated: true,
      dataUpdateTime: "2026-07-22T15:42:04+08:00",
      delayNotice: RAIL_LIVEBOARD_DELAY_NOTICE
    });
    expect(text).toContain("200");
  });
});
