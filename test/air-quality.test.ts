import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OpenDataApiError } from "../src/services/errors.js";
import { formatAirQualityText, runAirQuality } from "../src/tools/air-quality.js";
import { jsonFetch } from "./helpers.js";

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

  it("passes the MOENV filters syntax and api_key as query parameters", async () => {
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
    const emptyFetch = jsonFetch({ ...fixture, records: [] });
    await expect(runAirQuality({ siteName: "不存在站" }, "test-key", emptyFetch)).rejects.toThrow(/不存在站/);
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
