import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatYouBikeText, runYouBike } from "../../src/tools/bike.js";
import type { TdxBikeAvailabilityRawRecord, TdxBikeStationRawRecord } from "../../src/registry/tdx.js";
import { YOUBIKE_MAX_STATIONS_RETURNED } from "../../src/constants.js";

const availabilityFixture: TdxBikeAvailabilityRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/youbike-availability.json", import.meta.url)), "utf-8")
);
const stationFixture: TdxBikeStationRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/youbike-station.json", import.meta.url)), "utf-8")
);

function tokenThenDataFetch(availability: unknown[], station: unknown[]): typeof fetch {
  return (async (url: string) => {
    if (url === "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token") {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("Bike/Station")) {
      return new Response(JSON.stringify(station), { status: 200 });
    }
    return new Response(JSON.stringify(availability), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("runYouBike", () => {
  it("joins availability and station records by StationUID, using the real fixtures", async () => {
    const result = await runYouBike(
      { city: "Taipei" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(availabilityFixture, stationFixture)
    );

    expect(result.totalMatched).toBe(availabilityFixture.length);
    const first = result.stations.find(s => s.stationUid === availabilityFixture[0].StationUID);
    expect(first?.stationName).toBe(stationFixture[0].StationName?.Zh_tw);
    expect(first?.totalCapacity).toBe(stationFixture[0].BikesCapacity);
    expect(first?.availableRentBikes).toBe(availabilityFixture[0].AvailableRentBikes);
  });

  it("returns null station fields (not a crash) when an availability record has no matching station metadata", async () => {
    const orphanAvailability = [{ StationUID: "NO-MATCH", AvailableRentBikes: 5, AvailableReturnBikes: 2 }];
    const result = await runYouBike(
      { city: "Taipei" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(orphanAvailability, stationFixture)
    );
    expect(result.stations[0].stationName).toBeNull();
    expect(result.stations[0].availableRentBikes).toBe(5);
  });

  it("filters by stationName substring, matching either language", async () => {
    const targetName = stationFixture[0].StationName!.Zh_tw!;
    const result = await runYouBike(
      { city: "Taipei", stationName: targetName.slice(0, 4) },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(availabilityFixture, stationFixture)
    );
    expect(result.totalMatched).toBeGreaterThan(0);
    expect(result.stations.every(s => s.stationName?.includes(targetName.slice(0, 4)))).toBe(true);
  });

  it("propagates the missing-credentials error", async () => {
    await expect(
      runYouBike({ city: "Taipei" }, { TDX_CLIENT_ID: undefined, TDX_CLIENT_SECRET: undefined })
    ).rejects.toThrow(/tdx\.transportdata\.tw/);
  });

  it("caps the returned stations and reports truncated: true when matches exceed the limit", async () => {
    const manyAvailability = Array.from({ length: YOUBIKE_MAX_STATIONS_RETURNED + 5 }, (_, i) => ({
      StationUID: `X${i}`,
      AvailableRentBikes: 1,
      AvailableReturnBikes: 1
    }));
    const result = await runYouBike(
      { city: "Taipei" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(manyAvailability, [])
    );
    expect(result.totalMatched).toBe(YOUBIKE_MAX_STATIONS_RETURNED + 5);
    expect(result.stations).toHaveLength(YOUBIKE_MAX_STATIONS_RETURNED);
    expect(result.truncated).toBe(true);
  });
});

describe("formatYouBikeText", () => {
  it("renders station name, availability counts, and update time", () => {
    const text = formatYouBikeText({
      query: { city: "Taipei" },
      stations: [
        {
          stationUid: "TPE1",
          stationName: "YouBike2.0_測試站",
          stationNameEn: "Test Station",
          address: null,
          latitude: null,
          longitude: null,
          availableRentBikes: 8,
          availableGeneralBikes: 5,
          availableElectricBikes: 3,
          availableReturnBikes: 10,
          totalCapacity: 20,
          updateTime: "2026-07-22T12:07:36+08:00"
        }
      ],
      totalMatched: 1,
      truncated: false
    });

    expect(text).toContain("YouBike2.0_測試站");
    expect(text).toContain("可借 8 輛");
    expect(text).toContain("一般 5 輛");
    expect(text).toContain("電輔 3 輛");
    expect(text).toContain("可還 10 位");
    expect(text).toContain("總車位數 20");
    expect(text).toContain("2026-07-22T12:07:36+08:00");
  });

  it("reports zero matches in plain language, not as an error", () => {
    const text = formatYouBikeText({ query: { city: "Taipei", stationName: "no-such-station" }, stations: [], totalMatched: 0, truncated: false });
    expect(text).toContain("查無");
    expect(text).toContain("不代表本伺服器資料異常");
  });

  it("warns and points to stationName when the result was truncated", () => {
    const text = formatYouBikeText({
      query: { city: "Taipei" },
      stations: [
        {
          stationUid: "TPE1",
          stationName: "s",
          stationNameEn: "s",
          address: null,
          latitude: null,
          longitude: null,
          availableRentBikes: null,
          availableGeneralBikes: null,
          availableElectricBikes: null,
          availableReturnBikes: null,
          totalCapacity: null,
          updateTime: null
        }
      ],
      totalMatched: 2000,
      truncated: true
    });
    expect(text).toContain("2000");
    expect(text).toContain("stationName");
  });
});
