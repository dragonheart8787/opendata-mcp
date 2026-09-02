import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { formatGlobalWeatherText, handleGlobalWeatherTool, runGlobalWeather } from "../../src/tools/global-weather.js";
import type { Env } from "../../src/index.js";
import { jsonFetch, rejectingFetch } from "../helpers.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/openmeteo-forecast.json", import.meta.url)), "utf-8")
);

const env: Env = {};
const params = { latitude: 35.6785, longitude: 139.6823, forecastDays: 3 };

describe("runGlobalWeather", () => {
  it("fetches and transforms in one step, with no API key involved", async () => {
    const result = await runGlobalWeather(params, env, jsonFetch(fixture));
    expect(result.current?.temperatureC).toBe(23.2);
    expect(result.daily).toHaveLength(3);
  });
});

describe("formatGlobalWeatherText", () => {
  it("shows both the requested and the grid-snapped coordinate, so the shift isn't hidden in structured data only", async () => {
    const text = formatGlobalWeatherText(await runGlobalWeather(params, env, jsonFetch(fixture)));
    expect(text).toContain("35.6785");
    expect(text).toContain("35.7");
    expect(text).toContain("模式網格點");
  });

  it("states the timezone, because every timestamp it prints has no offset of its own", async () => {
    const text = formatGlobalWeatherText(await runGlobalWeather(params, env, jsonFetch(fixture)));
    expect(text).toContain("Asia/Tokyo");
    expect(text).toContain("當地時間");
  });

  it("renders current conditions and each forecast day", async () => {
    const text = formatGlobalWeatherText(await runGlobalWeather(params, env, jsonFetch(fixture)));
    expect(text).toContain("降雨：小雨");
    expect(text).toContain("23.2°C");
    expect(text).toContain("2026-08-11");
    expect(text).toContain("2026-08-13");
    expect(text).toContain("21.4–26.9°C");
  });

  it("always ends with the CC BY 4.0 attribution", async () => {
    const text = formatGlobalWeatherText(await runGlobalWeather(params, env, jsonFetch(fixture)));
    expect(text).toContain("Weather data by Open-Meteo.com");
    expect(text).toContain("CC BY 4.0");
    expect(text).toContain("政府資料開放授權條款");
  });

  it("degrades to a plain message rather than crashing when upstream returns no blocks", async () => {
    const text = formatGlobalWeatherText(await runGlobalWeather(params, env, jsonFetch({ latitude: 1, longitude: 2 })));
    expect(text).toContain("上游未回傳目前天氣資料");
    expect(text).toContain("上游未回傳每日預報資料");
    // Attribution is a licence condition — it survives an empty response.
    expect(text).toContain("Weather data by Open-Meteo.com");
  });
});

describe("handleGlobalWeatherTool", () => {
  it("emits BOTH provenance and licence in the envelope, because this source is neither official nor OGDL", async () => {
    const result = await handleGlobalWeatherTool(params, env, jsonFetch(fixture));
    const envelope = result.structuredContent as Record<string, unknown>;

    expect(envelope.ok).toBe(true);
    expect(envelope.provenance).toBe("third-party-aggregator");
    expect(envelope.licence).toMatchObject({
      id: "cc-by-4.0",
      commercialUseAllowed: false
    });
    expect(envelope.dataset).toBe("openmeteo:forecast");
  });

  it("names the source as explicitly non-official, since every other source in this server is a ministry", async () => {
    const result = await handleGlobalWeatherTool(params, env, jsonFetch(fixture));
    expect((result.structuredContent as Record<string, unknown>).source).toContain("非官方");
  });

  it("puts the attribution inside structuredContent.data too, not only in the content text", async () => {
    // The tw_rail lesson: clients that read structuredContent and ignore
    // `content` must still receive the licence-required credit.
    const result = await handleGlobalWeatherTool(params, env, jsonFetch(fixture));
    const envelope = result.structuredContent as { data: { attribution: string } };
    expect(envelope.data.attribution).toContain("Weather data by Open-Meteo.com");
  });

  it("returns a failure envelope on upstream error", async () => {
    const result = await handleGlobalWeatherTool(params, env, rejectingFetch(new Error("boom")));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "UPSTREAM_ERROR" } });
  });
});
