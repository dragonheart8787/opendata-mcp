import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatYouBikeText, handleYouBikeTool, runYouBike } from "../../src/tools/bike.js";
import type { TdxBikeAvailabilityRawRecord, TdxBikeStationRawRecord } from "../../src/registry/tdx.js";
import { YOUBIKE_MAX_STATIONS_RETURNED } from "../../src/constants.js";

const availabilityFixture: TdxBikeAvailabilityRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/youbike-availability.json", import.meta.url)), "utf-8")
);
const stationFixture: TdxBikeStationRawRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/youbike-station.json", import.meta.url)), "utf-8")
);

const TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

function tokenThenDataFetch(availability: unknown[], station: unknown[]): typeof fetch {
  return (async (url: string) => {
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("Bike/Station")) {
      return new Response(JSON.stringify(station), { status: 200 });
    }
    return new Response(JSON.stringify(availability), { status: 200 });
  }) as unknown as typeof fetch;
}

/** Availability succeeds; the Station endpoint returns a real HTTP error — the boundary case runYouBike must degrade on, not fail on. */
function fetchWithStationFailure(availability: unknown[]): typeof fetch {
  return (async (url: string) => {
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("Bike/Station")) {
      return new Response("station endpoint down", { status: 500 });
    }
    return new Response(JSON.stringify(availability), { status: 200 });
  }) as unknown as typeof fetch;
}

/** The reverse boundary case: Availability fails — there's no bike-count data to show, so this must still fail the whole call even though Station would have succeeded. */
function fetchWithAvailabilityFailure(station: unknown[]): typeof fetch {
  return (async (url: string) => {
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("Bike/Station")) {
      return new Response(JSON.stringify(station), { status: 200 });
    }
    return new Response("availability endpoint down", { status: 500 });
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

  describe("partial upstream failure (two-entry join boundary case)", () => {
    it("degrades to StationUID-only output when station metadata fails but availability succeeds", async () => {
      const result = await runYouBike(
        { city: "Taipei" },
        { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
        fetchWithStationFailure(availabilityFixture)
      );

      expect(result.stationMetadataUnavailable).toBe(true);
      // The bike counts — the actual point of this tool — still come through.
      expect(result.totalMatched).toBe(availabilityFixture.length);
      expect(result.stations[0].stationUid).toBe(availabilityFixture[0].StationUID);
      expect(result.stations[0].availableRentBikes).toBe(availabilityFixture[0].AvailableRentBikes);
      // No name to give, so it stays null (formatYouBikeText falls back to
      // the StationUID for display) rather than a fabricated placeholder.
      expect(result.stations.every(s => s.stationName === null && s.totalCapacity === null)).toBe(true);
    });

    it("ignores an unhonorable stationName filter when station metadata is unavailable, instead of reporting zero matches", async () => {
      const result = await runYouBike(
        { city: "Taipei", stationName: "some real station name" },
        { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
        fetchWithStationFailure(availabilityFixture)
      );

      expect(result.stationMetadataUnavailable).toBe(true);
      // Nothing has a name to match against, so the filter is skipped
      // rather than silently matching zero and looking like "no such
      // station" — the query still records what the caller asked for.
      expect(result.totalMatched).toBe(availabilityFixture.length);
      expect(result.query.stationName).toBe("some real station name");
    });

    it("fails the whole call when availability itself fails, even though station metadata would have succeeded", async () => {
      await expect(
        runYouBike(
          { city: "Taipei" },
          { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
          fetchWithAvailabilityFailure(stationFixture)
        )
      ).rejects.toThrow();
    });

    it("handleYouBikeTool still returns a successful (non-error) MCP result when only station metadata failed", async () => {
      const result = await handleYouBikeTool(
        { city: "Taipei" },
        { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
        fetchWithStationFailure(availabilityFixture)
      );

      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { ok?: boolean }).ok).toBe(true);
      expect(result.content[0]?.text).toContain("站點基本資料");
    });

    it("handleYouBikeTool returns an error MCP result when availability fails", async () => {
      const result = await handleYouBikeTool(
        { city: "Taipei" },
        { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
        fetchWithAvailabilityFailure(stationFixture)
      );

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { ok?: boolean }).ok).toBe(false);
    });
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
      truncated: false,
      stationMetadataUnavailable: false
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
    const text = formatYouBikeText({
      query: { city: "Taipei", stationName: "no-such-station" },
      stations: [],
      totalMatched: 0,
      truncated: false,
      stationMetadataUnavailable: false
    });
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
      truncated: true,
      stationMetadataUnavailable: false
    });
    expect(text).toContain("2000");
    expect(text).toContain("stationName");
  });

  it("shows a degraded-data warning, and falls back to StationUID as the display name, when station metadata is unavailable", () => {
    const text = formatYouBikeText({
      query: { city: "Taipei", stationName: "somewhere" },
      stations: [
        {
          stationUid: "TPE500101001",
          stationName: null,
          stationNameEn: null,
          address: null,
          latitude: null,
          longitude: null,
          availableRentBikes: 3,
          availableGeneralBikes: null,
          availableElectricBikes: null,
          availableReturnBikes: 5,
          totalCapacity: null,
          updateTime: null
        }
      ],
      totalMatched: 1,
      truncated: false,
      stationMetadataUnavailable: true
    });

    expect(text).toContain("站點基本資料");
    expect(text).toContain("TPE500101001");
    expect(text).toContain("忽略 stationName");
  });
});
