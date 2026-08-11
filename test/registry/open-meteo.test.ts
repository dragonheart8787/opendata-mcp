import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OPEN_METEO_ATTRIBUTION, WMO_THUNDERSTORM_CODES_REGIONAL_NOTE } from "../../src/constants.js";
import {
  decodeWeatherCode,
  openMeteoForecastEntry,
  openMeteoGeocodingEntry,
  type OpenMeteoForecastRawResponse,
  type OpenMeteoGeocodingRawResponse
} from "../../src/registry/open-meteo.js";

// Captured 2026-08-11 from the live API via GitHub Actions (this sandbox's
// egress proxy denies api.open-meteo.com — see constants.ts), using the
// exact query string `buildOpenMeteoUrl` produces for each entry's
// sampleParams.
const forecastFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/openmeteo-forecast.json", import.meta.url)), "utf-8")
) as OpenMeteoForecastRawResponse;

const geocodingFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/openmeteo-geocoding.json", import.meta.url)), "utf-8")
) as OpenMeteoGeocodingRawResponse;

const forecastParams = { latitude: 35.6785, longitude: 139.6823, forecastDays: 3 };

describe("openmeteo:forecast buildQueryParams", () => {
  it("always sends timezone=auto, because omitting it makes upstream answer in GMT with offset-less timestamps", () => {
    expect(openMeteoForecastEntry.buildQueryParams(forecastParams).timezone).toBe("auto");
  });

  it("requests the current and daily variable lists as comma-separated values", () => {
    const query = openMeteoForecastEntry.buildQueryParams(forecastParams);
    expect(query.current).toContain("temperature_2m");
    expect(query.current).toContain("weather_code");
    expect(query.daily).toContain("temperature_2m_max");
    expect(query.daily).toContain("precipitation_probability_max");
    expect(query.latitude).toBe("35.6785");
    expect(query.longitude).toBe("139.6823");
    expect(query.forecast_days).toBe("3");
  });

  it("falls back to the default forecast day count when the caller omits it", () => {
    expect(openMeteoForecastEntry.buildQueryParams({ latitude: 0, longitude: 0 }).forecast_days).toBe("3");
  });
});

describe("openmeteo:forecast transform", () => {
  it("maps the real fixture's current conditions onto the compact shape", () => {
    const result = openMeteoForecastEntry.transform(forecastFixture, forecastParams);

    expect(result.current).not.toBeNull();
    expect(result.current?.temperatureC).toBe(23.2);
    expect(result.current?.apparentTemperatureC).toBe(25.2);
    expect(result.current?.relativeHumidityPercent).toBe(79);
    expect(result.current?.windSpeedKmh).toBe(11.0);
    expect(result.current?.windGustsKmh).toBe(52.9);
    expect(result.current?.cloudCoverPercent).toBe(97);
    expect(result.current?.time).toBe("2026-08-11T17:45");
  });

  it("converts is_day's 1/0 integer into a real boolean", () => {
    expect(openMeteoForecastEntry.transform(forecastFixture, forecastParams).current?.isDay).toBe(true);

    const atNight = { ...forecastFixture, current: { ...forecastFixture.current, is_day: 0 } };
    expect(openMeteoForecastEntry.transform(atNight, forecastParams).current?.isDay).toBe(false);
  });

  it("surfaces BOTH the requested coordinate and the grid-snapped one upstream actually answered for", () => {
    // The whole point of this assertion: upstream silently moved the query
    // from 35.6785,139.6823 to its model grid at 35.7,139.6875. A caller
    // that can't see that can't tell how far away the forecast really is.
    const result = openMeteoForecastEntry.transform(forecastFixture, forecastParams);

    expect(result.requested).toEqual({ latitude: 35.6785, longitude: 139.6823, forecastDays: 3 });
    expect(result.resolved.latitude).toBe(35.7);
    expect(result.resolved.longitude).toBe(139.6875);
    expect(result.resolved.latitude).not.toBe(result.requested.latitude);
    expect(result.resolved.elevationM).toBe(48.0);
  });

  it("carries the resolved timezone alongside the offset-less timestamps, so they can be read correctly", () => {
    const result = openMeteoForecastEntry.transform(forecastFixture, forecastParams);

    expect(result.timezone).toBe("Asia/Tokyo");
    expect(result.timezoneAbbreviation).toBe("GMT+9");
    expect(result.utcOffsetSeconds).toBe(32400);
    // The timestamp itself genuinely has no offset suffix — that's upstream's
    // format, and exactly why the three fields above have to travel with it.
    expect(result.current?.time).not.toMatch(/[+-]\d{2}:\d{2}$|Z$/);
  });

  it("pivots the columnar daily object into one record per day, keeping every column aligned to its date", () => {
    const result = openMeteoForecastEntry.transform(forecastFixture, forecastParams);

    expect(result.daily).toHaveLength(3);
    expect(result.daily[0]).toMatchObject({
      date: "2026-08-11",
      temperatureMaxC: 26.9,
      temperatureMinC: 21.4,
      precipitationSumMm: 13.9,
      precipitationProbabilityMaxPercent: 100,
      windSpeedMaxKmh: 10.8,
      sunrise: "2026-08-11T04:56",
      sunset: "2026-08-11T18:36"
    });
    expect(result.daily[2]).toMatchObject({
      date: "2026-08-13",
      temperatureMaxC: 27.3,
      precipitationSumMm: 5.6,
      windSpeedMaxKmh: 4.1
    });
  });

  it("decodes each day's WMO code into the transcribed English wording plus this server's Chinese one", () => {
    const result = openMeteoForecastEntry.transform(forecastFixture, forecastParams);

    expect(result.daily[0].weather).toEqual({
      code: 63,
      description: "Rain: Moderate intensity",
      descriptionZh: "降雨：中雨"
    });
    expect(result.current?.weather).toEqual({
      code: 61,
      description: "Rain: Slight intensity",
      descriptionZh: "降雨：小雨"
    });
  });

  it("embeds the CC BY 4.0 attribution in the DATA, not only in the tool description", () => {
    const result = openMeteoForecastEntry.transform(forecastFixture, forecastParams);
    expect(result.attribution).toBe(OPEN_METEO_ATTRIBUTION);
    // The credit line Open-Meteo's licence page explicitly asks for.
    expect(result.attribution).toContain("Weather data by Open-Meteo.com");
    expect(result.attribution).toContain("CC BY 4.0");
  });

  it("omits the thunderstorm note when no thunderstorm code is present", () => {
    const result = openMeteoForecastEntry.transform(forecastFixture, forecastParams);
    expect("weatherCodeNote" in result).toBe(false);
  });

  it("adds Open-Meteo's own Central-Europe-only caveat when a thunderstorm code does appear", () => {
    const withThunder = {
      ...forecastFixture,
      current: { ...forecastFixture.current, weather_code: 95 }
    };
    const result = openMeteoForecastEntry.transform(withThunder, forecastParams);
    expect(result.weatherCodeNote).toBe(WMO_THUNDERSTORM_CODES_REGIONAL_NOTE);
  });

  it("returns an empty daily list rather than throwing when upstream sends no daily block at all", () => {
    const result = openMeteoForecastEntry.transform({ latitude: 1, longitude: 2 }, forecastParams);
    expect(result.daily).toEqual([]);
    expect(result.current).toBeNull();
    // Attribution is a licence condition, so it survives an empty response.
    expect(result.attribution).toBe(OPEN_METEO_ATTRIBUTION);
  });

  it("tolerates a short column: a day beyond a column's length yields null, not a crash or a shifted value", () => {
    // Columns are never assumed equal-length just because they always have
    // been — a truncated column must not silently shift later days' values.
    const ragged: OpenMeteoForecastRawResponse = {
      daily: {
        time: ["2026-08-11", "2026-08-12", "2026-08-13"],
        temperature_2m_max: [26.9],
        weather_code: [63, 65, 55]
      }
    };
    const result = openMeteoForecastEntry.transform(ragged, forecastParams);

    expect(result.daily).toHaveLength(3);
    expect(result.daily[0].temperatureMaxC).toBe(26.9);
    expect(result.daily[1].temperatureMaxC).toBeNull();
    expect(result.daily[2].temperatureMaxC).toBeNull();
    // ...while the full-length column stays correctly aligned.
    expect(result.daily[2].weather.code).toBe(55);
  });
});

describe("decodeWeatherCode", () => {
  it("decodes every code in the transcribed table", () => {
    expect(decodeWeatherCode(0)).toEqual({ code: 0, description: "Clear sky", descriptionZh: "晴朗無雲" });
    expect(decodeWeatherCode(45).descriptionZh).toBe("有霧");
    expect(decodeWeatherCode(99).description).toBe("Thunderstorm with heavy hail");
  });

  it("keeps an unknown code as a raw number with null descriptions instead of inventing a label", () => {
    expect(decodeWeatherCode(42)).toEqual({ code: 42, description: null, descriptionZh: null });
  });

  it("yields an all-null result for a missing or non-numeric code", () => {
    expect(decodeWeatherCode(undefined)).toEqual({ code: null, description: null, descriptionZh: null });
    expect(decodeWeatherCode("61")).toEqual({ code: null, description: null, descriptionZh: null });
  });
});

describe("openmeteo:geocoding transform", () => {
  it("maps the real fixture's matches onto the compact shape", () => {
    const params = { name: "Tokyo", count: 3, language: "en" };
    const result = openMeteoGeocodingEntry.transform(geocodingFixture, params);

    expect(result.places).toHaveLength(3);
    expect(result.places[0]).toEqual({
      name: "Tokyo",
      latitude: 35.6895,
      longitude: 139.69171,
      elevationM: 44.0,
      country: "Japan",
      countryCode: "JP",
      admin1: "Tokyo",
      timezone: "Asia/Tokyo",
      population: 9733276
    });
    expect(result.query).toEqual({ name: "Tokyo", count: 3, language: "en" });
  });

  it("keeps every same-named match, so an ambiguous place name is visible rather than silently resolved", () => {
    // The real capture for "Tokyo" returns three genuinely different places
    // (Japan, Papua New Guinea, Nepal) — picking one for the caller would be
    // this server guessing.
    const result = openMeteoGeocodingEntry.transform(geocodingFixture, { name: "Tokyo" });
    expect(result.places.map(place => place.country)).toEqual(["Japan", "Papua New Guinea", "Nepal"]);
  });

  it("returns an empty list when upstream OMITS the results key entirely on a no-match", () => {
    // Confirmed by a real probe: a no-match returns exactly
    // `{"generationtime_ms": 0.42831898}` — no `results` key at all. Reading
    // `.results.length` here would throw on the most likely caller mistake.
    const result = openMeteoGeocodingEntry.transform({ generationtime_ms: 0.42831898 }, { name: "zzzzqqqqxxxx" });
    expect(result.places).toEqual([]);
  });

  it("normalizes a record missing optional fields to nulls rather than undefined", () => {
    const result = openMeteoGeocodingEntry.transform({ results: [{ name: "Nowhere" }] }, { name: "Nowhere" });
    expect(result.places[0]).toEqual({
      name: "Nowhere",
      latitude: null,
      longitude: null,
      elevationM: null,
      country: null,
      countryCode: null,
      admin1: null,
      timezone: null,
      population: null
    });
  });

  it("defaults count/language when the caller omits them", () => {
    const query = openMeteoGeocodingEntry.buildQueryParams({ name: "Tokyo" });
    expect(query).toEqual({ name: "Tokyo", count: "5", language: "en", format: "json" });
  });

  it("carries the CC BY 4.0 attribution too — the licence applies to this endpoint as well", () => {
    expect(openMeteoGeocodingEntry.transform(geocodingFixture, { name: "Tokyo" }).attribution).toBe(OPEN_METEO_ATTRIBUTION);
  });
});
