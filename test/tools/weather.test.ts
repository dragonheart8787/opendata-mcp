import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/infra/errors.js";
import { formatWeatherForecastText, runWeatherForecast } from "../../src/tools/weather.js";
import { jsonFetch } from "../helpers.js";

// This fixture is overwritten with a real, live forecast whenever
// scripts/fixtures/refresh-fixtures.ts detects structural drift — so its
// specific temperatures/weather text change over time. Tests below derive
// expected values from the fixture's own raw fields rather than hardcoding
// literals, so a routine refresh never breaks them on its own.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/weather-forecast.json", import.meta.url)), "utf-8")
);
const location = fixture.records.location.find((l: any) => l.locationName === "臺北市");

function findElement(elementName: string) {
  return location.weatherElement.find((e: any) => e.elementName === elementName);
}

describe("runWeatherForecast", () => {
  it("extracts a compact per-period forecast matching the raw CWA fields", async () => {
    const result = await runWeatherForecast("臺北市", "test-key", jsonFetch(fixture));
    const wx = findElement("Wx");
    const pop = findElement("PoP");
    const minT = findElement("MinT");
    const maxT = findElement("MaxT");
    const ci = findElement("CI");

    expect(result.city).toBe("臺北市");
    expect(result.periods).toHaveLength(wx.time.length);
    result.periods.forEach((period, i) => {
      expect(period.startTime).toBe(wx.time[i].startTime);
      expect(period.endTime).toBe(wx.time[i].endTime);
      expect(period.weather).toBe(wx.time[i].parameter.parameterName);
      expect(period.rainProbabilityPercent).toBe(Number(pop.time[i].parameter.parameterName));
      expect(period.minTemperatureC).toBe(Number(minT.time[i].parameter.parameterName));
      expect(period.maxTemperatureC).toBe(Number(maxT.time[i].parameter.parameterName));
      expect(period.comfortIndex).toBe(ci.time[i].parameter.parameterName);
    });
  });

  it("throws an actionable error when the requested city is not in the response", async () => {
    await expect(runWeatherForecast("高雄市", "test-key", jsonFetch(fixture))).rejects.toThrow(ToolError);
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
    const wx = findElement("Wx");
    const pop = findElement("PoP");
    const minT = findElement("MinT");
    const maxT = findElement("MaxT");

    expect(text).toContain("臺北市 36 小時天氣預報");
    expect(text).toContain(wx.time[0].parameter.parameterName);
    expect(text).toContain(`降雨機率：${pop.time[0].parameter.parameterName}%`);
    expect(text).toContain(`${minT.time[0].parameter.parameterName}°C ~ ${maxT.time[0].parameter.parameterName}°C`);
  });
});
