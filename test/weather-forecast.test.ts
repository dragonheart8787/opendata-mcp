import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CwaApiError } from "../src/services/cwa-client.js";
import { formatWeatherForecastText, runWeatherForecast } from "../src/tools/weather-forecast.js";
import { jsonFetch } from "./helpers.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/weather-forecast.json", import.meta.url)), "utf-8")
);

describe("runWeatherForecast", () => {
  it("extracts a compact per-period forecast from the raw CWA response", async () => {
    const result = await runWeatherForecast("臺北市", "test-key", jsonFetch(fixture));

    expect(result.city).toBe("臺北市");
    expect(result.periods).toHaveLength(3);
    expect(result.periods[0]).toEqual({
      startTime: "2026-07-19 18:00:00",
      endTime: "2026-07-20 06:00:00",
      weather: "多雲時晴",
      rainProbabilityPercent: 10,
      minTemperatureC: 27,
      maxTemperatureC: 30,
      comfortIndex: "舒適"
    });
    expect(result.periods[1].weather).toBe("午後短暫雷陣雨");
    expect(result.periods[1].rainProbabilityPercent).toBe(70);
  });

  it("throws an actionable error when the requested city is not in the response", async () => {
    await expect(runWeatherForecast("高雄市", "test-key", jsonFetch(fixture))).rejects.toThrow(CwaApiError);
    await expect(runWeatherForecast("高雄市", "test-key", jsonFetch(fixture))).rejects.toThrow(/高雄市/);
  });

  it("propagates the missing-API-key error", async () => {
    await expect(runWeatherForecast("臺北市", undefined)).rejects.toThrow(/CWA_API_KEY/);
  });
});

describe("formatWeatherForecastText", () => {
  it("renders a human-readable summary including all periods", async () => {
    const result = await runWeatherForecast("臺北市", "test-key", jsonFetch(fixture));
    const text = formatWeatherForecastText(result);

    expect(text).toContain("臺北市 36 小時天氣預報");
    expect(text).toContain("多雲時晴");
    expect(text).toContain("降雨機率：70%");
    expect(text).toContain("28°C ~ 34°C");
  });
});
