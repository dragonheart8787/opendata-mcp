import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatBusEtaText, runBusEta } from "../../src/tools/bus-eta.js";
import type { TdxBusEtaRawRecord } from "../../src/registry/tdx.js";

// Real field structure confirmed 2026-07-22 via a real dispatch of
// fixtures-refresh.yml (Taipei, route 615) — see the module comment on
// registry/tdx.ts.
const fixture: TdxBusEtaRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/bus-eta.json", import.meta.url)), "utf-8")
);
const withoutEstimate = fixture[0];

// The route-615 fixture happened to capture a moment with zero live buses
// (all records have StopStatus 1, none carry EstimateTime) — a genuine
// real state, not a fixture gap. This record's field *values* are verbatim
// from the same 2026-07-22 real dispatch (the unfiltered Taipei-wide
// capture used to first confirm the shape) — see test/registry/tdx.test.ts
// for the identical rationale.
const withEstimate: TdxBusEtaRawRecord = {
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
};

function tokenThenDataFetch(records: unknown[]): typeof fetch {
  return (async (url: string) => {
    if (url === "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token") {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(records), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("runBusEta", () => {
  it("maps the real fixture onto the compact stop summary", async () => {
    const result = await runBusEta(
      { city: "Taipei", routeName: "615" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(fixture)
    );

    expect(result.totalMatched).toBe(fixture.length);
    expect(result.stops.every(s => s.routeName === "615")).toBe(true);
  });

  it("propagates the missing-credentials error", async () => {
    await expect(
      runBusEta({ city: "Taipei" }, { TDX_CLIENT_ID: undefined, TDX_CLIENT_SECRET: undefined })
    ).rejects.toThrow(/tdx\.transportdata\.tw/);
  });

  it("filters by stopName client-side even against an unfiltered upstream response", async () => {
    const result = await runBusEta(
      { city: "Taipei", stopName: withoutEstimate.StopName!.Zh_tw },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(fixture)
    );
    expect(result.totalMatched).toBeGreaterThan(0);
    expect(result.stops.every(s => s.stopName === withoutEstimate.StopName!.Zh_tw)).toBe(true);
  });
});

describe("formatBusEtaText", () => {
  it("renders each stop's route, direction, estimate, and update time", () => {
    const text = formatBusEtaText({
      query: { city: "Taipei", routeName: "615" },
      stops: [
        {
          routeName: withEstimate.RouteName!.Zh_tw!,
          routeNameEn: withEstimate.RouteName!.En!,
          stopName: withEstimate.StopName!.Zh_tw!,
          stopNameEn: withEstimate.StopName!.En!,
          direction: withEstimate.Direction!,
          estimateSeconds: withEstimate.EstimateTime!,
          stopStatusCode: withEstimate.StopStatus!,
          updateTime: withEstimate.UpdateTime!
        }
      ],
      totalMatched: 1,
      truncated: false
    });

    expect(text).toContain(withEstimate.RouteName!.Zh_tw!);
    expect(text).toContain(withEstimate.StopName!.Zh_tw!);
    expect(text).toContain(withEstimate.UpdateTime!);
  });

  it("shows a plain-language message (not an error) when EstimateTime is absent", () => {
    const text = formatBusEtaText({
      query: { city: "Taipei" },
      stops: [
        {
          routeName: withoutEstimate.RouteName!.Zh_tw!,
          routeNameEn: withoutEstimate.RouteName!.En!,
          stopName: withoutEstimate.StopName!.Zh_tw!,
          stopNameEn: withoutEstimate.StopName!.En!,
          direction: withoutEstimate.Direction!,
          estimateSeconds: null,
          stopStatusCode: withoutEstimate.StopStatus!,
          updateTime: withoutEstimate.UpdateTime!
        }
      ],
      totalMatched: 1,
      truncated: false
    });
    expect(text).toContain("目前無預估到站時間");
  });

  it("reports zero matches in plain language, not as an error", () => {
    const text = formatBusEtaText({
      query: { city: "Taipei", routeName: "no-such-route" },
      stops: [],
      totalMatched: 0,
      truncated: false
    });
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
