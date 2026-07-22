import { describe, expect, it } from "vitest";
import { formatBusEtaText, runBusEta } from "../../src/tools/bus-eta.js";
import { jsonFetch } from "../helpers.js";

// Real field structure confirmed 2026-07-22 via a real dispatch of
// fixtures-refresh.yml — see the module comment on registry/tdx.ts.
const rawRecords = [
  {
    StopUID: "TPE36407",
    StopID: "36407",
    StopName: { Zh_tw: "榮總一", En: "Veterans General Hospital I" },
    RouteUID: "TPE10442",
    RouteID: "10442",
    RouteName: { Zh_tw: "508區", En: "508Shuttle" },
    Direction: 1,
    EstimateTime: 580,
    StopStatus: 0,
    SrcUpdateTime: "2026-07-22T11:10:30+08:00",
    UpdateTime: "2026-07-22T11:10:37+08:00"
  },
  {
    StopUID: "TPE187095",
    StopID: "187095",
    StopName: { Zh_tw: "新莊高中", En: "Xinzhuang High School" },
    RouteUID: "TPE10471",
    RouteID: "10471",
    RouteName: { Zh_tw: "615", En: "615" },
    Direction: 1,
    StopStatus: 1,
    SrcUpdateTime: "2026-07-22T11:10:30+08:00",
    UpdateTime: "2026-07-22T11:10:37+08:00"
  }
];

function tokenThenDataFetch(records: unknown[]): typeof fetch {
  return (async (url: string) => {
    if (url === "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token") {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(records), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("runBusEta", () => {
  it("maps the real fixture-shaped records onto the compact stop summary", async () => {
    const result = await runBusEta(
      { city: "Taipei" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(rawRecords)
    );

    expect(result.totalMatched).toBe(2);
    expect(result.stops[0].routeName).toBe("508區");
    expect(result.stops[0].estimateSeconds).toBe(580);
    expect(result.stops[1].estimateSeconds).toBeNull();
  });

  it("propagates the missing-credentials error", async () => {
    await expect(
      runBusEta({ city: "Taipei" }, { TDX_CLIENT_ID: undefined, TDX_CLIENT_SECRET: undefined })
    ).rejects.toThrow(/tdx\.transportdata\.tw/);
  });

  it("filters by routeName client-side even against an unfiltered upstream response", async () => {
    const result = await runBusEta(
      { city: "Taipei", routeName: "615" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(rawRecords)
    );
    expect(result.totalMatched).toBe(1);
    expect(result.stops[0].routeName).toBe("615");
  });
});

describe("formatBusEtaText", () => {
  it("renders each stop's route, direction, estimate, and update time", () => {
    const text = formatBusEtaText({
      query: { city: "Taipei" },
      stops: [
        {
          routeName: "508區",
          routeNameEn: "508Shuttle",
          stopName: "榮總一",
          stopNameEn: "Veterans General Hospital I",
          direction: 1,
          estimateSeconds: 580,
          stopStatusCode: 0,
          updateTime: "2026-07-22T11:10:37+08:00"
        }
      ],
      totalMatched: 1,
      truncated: false
    });

    expect(text).toContain("508區");
    expect(text).toContain("榮總一");
    expect(text).toContain("約 10 分鐘後到站");
    expect(text).toContain("2026-07-22T11:10:37+08:00");
  });

  it("shows a plain-language message (not an error) when EstimateTime is absent", () => {
    const text = formatBusEtaText({
      query: { city: "Taipei" },
      stops: [
        {
          routeName: "615",
          routeNameEn: "615",
          stopName: "新莊高中",
          stopNameEn: "Xinzhuang High School",
          direction: 1,
          estimateSeconds: null,
          stopStatusCode: 1,
          updateTime: "2026-07-22T11:10:37+08:00"
        }
      ],
      totalMatched: 1,
      truncated: false
    });
    expect(text).toContain("目前無預估到站時間");
  });

  it("reports zero matches in plain language, not as an error", () => {
    const text = formatBusEtaText({ query: { city: "Taipei", routeName: "no-such-route" }, stops: [], totalMatched: 0, truncated: false });
    expect(text).toContain("查無");
    expect(text).toContain("不代表本伺服器資料異常");
  });

  it("warns and points to routeName/stopName when the result was truncated", () => {
    const text = formatBusEtaText({
      query: { city: "Taipei" },
      stops: [
        {
          routeName: "1",
          routeNameEn: "1",
          stopName: "s",
          stopNameEn: "s",
          direction: 0,
          estimateSeconds: null,
          stopStatusCode: 0,
          updateTime: null
        }
      ],
      totalMatched: 5000,
      truncated: true
    });
    expect(text).toContain("5000");
    expect(text).toContain("routeName");
  });
});
