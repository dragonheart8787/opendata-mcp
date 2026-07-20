import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AQX_P_432_FETCH_LIMIT } from "../src/constants.js";
import { OpenDataApiError } from "../src/services/errors.js";
import { formatAirQualityText, runAirQuality } from "../src/tools/air-quality.js";
import { jsonFetch } from "./helpers.js";

// Bare JSON array — confirmed from production Cloudflare Logs that MOENV's
// v2 API returns records unwrapped for this dataset, not `{ records: [...] }`.
// Field *values* below are still best-effort (not captured verbatim from the
// real response); if you have the actual payload, please replace them.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/air-quality.json", import.meta.url)), "utf-8")
);

describe("runAirQuality", () => {
  it("summarizes all stations of a county into a compact structure", async () => {
    const result = await runAirQuality({ county: "新北市" }, "test-key", jsonFetch(fixture));

    expect(result.query).toEqual({ county: "新北市" });
    expect(result.stations).toHaveLength(2);
    expect(result.stations[0]).toEqual({
      siteName: "板橋",
      county: "新北市",
      aqi: 62,
      status: "普通",
      mainPollutant: "細懸浮微粒",
      pm25: 17,
      pm10: 38,
      o3: 38.6,
      publishTime: "2026/07/19 14:00:00"
    });
  });

  it("maps MOENV's unavailable-value markers (empty string, '-') to null, not 0", async () => {
    const result = await runAirQuality({ county: "新北市" }, "test-key", jsonFetch(fixture));
    const xinzhuang = result.stations[1];

    expect(xinzhuang.siteName).toBe("新莊");
    expect(xinzhuang.pm25).toBeNull();
    expect(xinzhuang.o3).toBeNull();
    expect(xinzhuang.mainPollutant).toBeNull();
  });

  it("re-filters client-side even when the upstream ignores the filters param entirely", async () => {
    // Regression test for the production bug: MOENV returned the full,
    // unfiltered nationwide station list (all 3 counties mixed) regardless
    // of the `filters` query param sent. The fixture always returns all 3
    // records — the tool must still only return the requested county.
    const result = await runAirQuality({ county: "臺北市" }, "test-key", jsonFetch(fixture));

    expect(result.stations).toHaveLength(1);
    expect(result.stations[0].siteName).toBe("士林");
    expect(result.stations.every(s => s.county === "臺北市")).toBe(true);
  });

  it("builds a filters=county,EQ,{county} query param with the county actually requested", async () => {
    let requestedUrl = "";
    const capturingFetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await runAirQuality({ county: "臺北市" }, "test-key", capturingFetch);

    // Compare against the exact percent-encoding the runtime would produce
    // (URLSearchParams), not a hand-rolled encodeURIComponent guess.
    const expectedQueryFragment = new URLSearchParams({ filters: "county,EQ,臺北市" }).toString();
    expect(requestedUrl).toContain(expectedQueryFragment);
    expect(new URL(requestedUrl).searchParams.get("filters")).toBe("county,EQ,臺北市");
  });

  it("passes the MOENV filters syntax and api_key as query parameters for a county query", async () => {
    let requestedUrl = "";
    const capturingFetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await runAirQuality({ county: "新北市" }, "test-key", capturingFetch);

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("api_key")).toBe("test-key");
    expect(url.searchParams.get("filters")).toBe("county,EQ,新北市");
  });

  it("builds a filters=sitename,EQ,{siteName} query param for a station query", async () => {
    let requestedUrl = "";
    const capturingFetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await runAirQuality({ siteName: "板橋" }, "test-key", capturingFetch);

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("filters")).toBe("sitename,EQ,板橋");
  });

  it("warns when the fetched record count meets the configured limit (possible truncation)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fullPage = Array.from({ length: AQX_P_432_FETCH_LIMIT }, (_, i) => ({
      ...fixture[0],
      sitename: `站${i}`,
      county: "臺北市"
    }));

    await runAirQuality({ county: "臺北市" }, "test-key", jsonFetch(fullPage));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[air-quality]"));
    warnSpy.mockRestore();
  });

  it("does not warn on a normal, well-under-the-limit response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAirQuality({ county: "新北市" }, "test-key", jsonFetch(fixture));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("rejects a call with neither county nor siteName, with guidance", async () => {
    await expect(runAirQuality({}, "test-key", jsonFetch(fixture))).rejects.toThrow(OpenDataApiError);
    await expect(runAirQuality({}, "test-key", jsonFetch(fixture))).rejects.toThrow(/擇一|其中一個/);
  });

  it("rejects a call with both county and siteName", async () => {
    await expect(
      runAirQuality({ county: "新北市", siteName: "板橋" }, "test-key", jsonFetch(fixture))
    ).rejects.toThrow(/只能擇一/);
  });

  it("gives an actionable error for an unknown siteName", async () => {
    await expect(runAirQuality({ siteName: "不存在站" }, "test-key", jsonFetch(fixture))).rejects.toThrow(
      /不存在站/
    );
  });

  it("propagates the missing-API-key error with the signup URL", async () => {
    await expect(runAirQuality({ county: "新北市" }, undefined)).rejects.toThrow(/MOENV_API_KEY/);
    await expect(runAirQuality({ county: "新北市" }, undefined)).rejects.toThrow(/data\.moenv\.gov\.tw/);
  });

  it("surfaces an invalid-key message from the MOENV error envelope", async () => {
    const badKeyFetch = jsonFetch({ message: "api_key is not valid" });
    await expect(runAirQuality({ county: "新北市" }, "bad-key", badKeyFetch)).rejects.toThrow(
      /data\.moenv\.gov\.tw/
    );
  });
});

describe("formatAirQualityText", () => {
  it("renders a human-readable summary with AQI and status", async () => {
    const result = await runAirQuality({ county: "新北市" }, "test-key", jsonFetch(fixture));
    const text = formatAirQualityText(result);

    expect(text).toContain("新北市 空氣品質");
    expect(text).toContain("板橋");
    expect(text).toContain("AQI：62（普通）");
    expect(text).toContain("PM2.5：17 μg/m³");
    expect(text).toContain("PM2.5：無資料");
  });
});
