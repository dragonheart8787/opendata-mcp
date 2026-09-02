import { z } from "zod";

import {
  OPEN_METEO_CURRENT_VARIABLES,
  OPEN_METEO_DAILY_VARIABLES,
  OPEN_METEO_DEFAULT_FORECAST_DAYS,
  OPEN_METEO_FORECAST_CACHE_TTL_SECONDS,
  OPEN_METEO_FORECAST_DOC_URL,
  OPEN_METEO_FORECAST_PATH,
  OPEN_METEO_GEOCODING_CACHE_TTL_SECONDS,
  OPEN_METEO_GEOCODING_DEFAULT_RESULTS,
  OPEN_METEO_GEOCODING_DOC_URL,
  OPEN_METEO_GEOCODING_MAX_RESULTS,
  OPEN_METEO_GEOCODING_PATH,
  OPEN_METEO_MAX_FORECAST_DAYS,
  OPEN_METEO_ATTRIBUTION,
  WMO_THUNDERSTORM_CODES_REGIONAL_NOTE,
  WMO_WEATHER_CODES
} from "../constants.js";
import { registerEntry, type DatasetEntry } from "./index.js";

// --- openmeteo:forecast — global weather forecast by coordinate ---
//
// Real structure confirmed 2026-08-11 by calling the live API from GitHub
// Actions (this sandbox's egress proxy denies api.open-meteo.com, and
// WebFetch returns EGRESS_BLOCKED for open-meteo.com — see constants.ts).
// Abridged real response for
// `?latitude=35.6785&longitude=139.6823&current=...&daily=...&timezone=auto
// &forecast_days=3`:
//
//   {
//     "latitude": 35.7, "longitude": 139.6875,          <- SNAPPED to grid
//     "generationtime_ms": 0.243,
//     "utc_offset_seconds": 32400,
//     "timezone": "Asia/Tokyo", "timezone_abbreviation": "GMT+9",
//     "elevation": 48.0,
//     "current_units": { "time": "iso8601", "interval": "seconds",
//                        "temperature_2m": "°C", "weather_code": "wmo code", ... },
//     "current":       { "time": "2026-08-11T17:45", "interval": 900,
//                        "temperature_2m": 23.2, "weather_code": 61, ... },
//     "daily_units":   { "time": "iso8601", "temperature_2m_max": "°C",
//                        "sunrise": "iso8601", ... },
//     "daily":         { "time": ["2026-08-11", ...],
//                        "temperature_2m_max": [26.9, 25.2, 27.3], ... }
//   }
//
// THREE properties of this response drive the transform below, and each one
// is a trap if passed through naively:
//
// 1. **`daily` is COLUMNAR, not a list of days.** It is an object of
//    parallel arrays keyed by variable, all indexed by the same `time`
//    array. An LLM consuming that directly has to zip 10 arrays by index
//    without dropping alignment, so `transform` pivots it into one object
//    per day. Arrays are read by index against `time`'s length and each
//    value defaults to null if its array is short — never assumed
//    equal-length.
//
// 2. **The returned `latitude`/`longitude` are NOT the ones requested** —
//    upstream snaps them to its model grid (35.6785 -> 35.7). Both the
//    requested and the returned coordinates are surfaced, with the distance
//    implicitly visible, so a caller can see the forecast is for a nearby
//    grid cell rather than their exact point.
//
// 3. **Timestamps carry NO timezone offset** (`"2026-08-11T17:45"`), and
//    which zone they are in depends entirely on the `timezone` parameter:
//    with `timezone=auto` they are local to the coordinate (utc_offset_
//    seconds 32400 for Tokyo); WITHOUT it, upstream silently defaults to
//    GMT (confirmed: a Taipei call with no timezone returned
//    `"timezone": "GMT"`, `utc_offset_seconds: 0`). A bare "17:45" that
//    might be local or might be UTC is exactly the kind of value that gets
//    misread, so this entry ALWAYS sends `timezone=auto` and returns the
//    resolved `timezone`/`utcOffsetSeconds` alongside every timestamp.
//
// Per AGENTS.md §6 there is no client-side re-filter to do here: this
// endpoint takes a coordinate, not a filter over a larger list, so there is
// no "upstream ignored our filter" failure mode of the kind CWA/MOENV's
// `filters`/`locationName` have. The one thing upstream does silently
// change — the coordinate — is surfaced rather than filtered.
export const globalWeatherInputShape = {
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .describe("緯度，-90 到 90 之間的十進位度數（例如東京為 35.6785）。北緯為正、南緯為負。"),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .describe("經度，-180 到 180 之間的十進位度數（例如東京為 139.6823）。東經為正、西經為負。"),
  forecastDays: z
    .number()
    .int()
    .min(1)
    .max(OPEN_METEO_MAX_FORECAST_DAYS)
    .optional()
    .describe(
      `選填，要回傳幾天的每日預報（1 到 ${OPEN_METEO_MAX_FORECAST_DAYS}，預設 ${OPEN_METEO_DEFAULT_FORECAST_DAYS}）。` +
        `上限 ${OPEN_METEO_MAX_FORECAST_DAYS} 是本伺服器為控制回應長度自行設定的，不是 Open-Meteo 的上限。`
    )
};

export interface GlobalWeatherParams {
  latitude: number;
  longitude: number;
  forecastDays?: number;
}

export interface OpenMeteoForecastRawResponse {
  latitude?: number;
  longitude?: number;
  elevation?: number;
  utc_offset_seconds?: number;
  timezone?: string;
  timezone_abbreviation?: string;
  generationtime_ms?: number;
  current_units?: Record<string, string>;
  current?: Record<string, number | string | null>;
  daily_units?: Record<string, string>;
  daily?: Record<string, (number | string | null)[]>;
}

export interface WeatherCodeResult {
  code: number | null;
  /** Open-Meteo's own English wording for this WMO code, transcribed verbatim from their docs table. */
  description: string | null;
  /** This server's Chinese translation of `description` — labelled separately so a caller can tell transcription from translation. */
  descriptionZh: string | null;
}

export interface GlobalWeatherCurrentResult {
  /** Local time at the queried coordinate, WITHOUT an offset suffix — read it together with `timezone`/`utcOffsetSeconds`. */
  time: string | null;
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  relativeHumidityPercent: number | null;
  precipitationMm: number | null;
  rainMm: number | null;
  showersMm: number | null;
  snowfallCm: number | null;
  cloudCoverPercent: number | null;
  pressureMslHpa: number | null;
  windSpeedKmh: number | null;
  windDirectionDegrees: number | null;
  windGustsKmh: number | null;
  isDay: boolean | null;
  weather: WeatherCodeResult;
}

export interface GlobalWeatherDailyResult {
  date: string | null;
  weather: WeatherCodeResult;
  temperatureMaxC: number | null;
  temperatureMinC: number | null;
  apparentTemperatureMaxC: number | null;
  apparentTemperatureMinC: number | null;
  sunrise: string | null;
  sunset: string | null;
  precipitationSumMm: number | null;
  precipitationProbabilityMaxPercent: number | null;
  windSpeedMaxKmh: number | null;
}

export interface GlobalWeatherResult {
  [key: string]: unknown;
  /** Exactly what the caller asked for, kept so the grid snapping below is visible rather than silent. */
  requested: { latitude: number; longitude: number; forecastDays: number };
  /** What upstream actually answered for — snapped to its model grid, so usually NOT identical to `requested`. */
  resolved: { latitude: number | null; longitude: number | null; elevationM: number | null };
  timezone: string | null;
  timezoneAbbreviation: string | null;
  utcOffsetSeconds: number | null;
  current: GlobalWeatherCurrentResult | null;
  daily: GlobalWeatherDailyResult[];
  /** CC BY 4.0 attribution — a licence condition, so it lives in the data, not only in the tool description. */
  attribution: string;
  /** Present only when a thunderstorm code appears, per Open-Meteo's own regional footnote. */
  weatherCodeNote?: string;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Decodes a WMO code against the transcribed table. An unrecognized code
 * keeps its raw number with null descriptions rather than being labelled
 * with a guess — same discipline as highway's opaque EventType passthrough.
 */
export function decodeWeatherCode(value: unknown): WeatherCodeResult {
  const code = toNumber(value);
  if (code === null) {
    return { code: null, description: null, descriptionZh: null };
  }
  const known = WMO_WEATHER_CODES[code];
  return {
    code,
    description: known?.description ?? null,
    descriptionZh: known?.descriptionZh ?? null
  };
}

/** Codes Open-Meteo's docs mark as Central-Europe-only (the `*` footnote on rows "95 *" and "96, 99 *"). */
const REGIONAL_THUNDERSTORM_CODES = new Set([95, 96, 99]);

/**
 * Pivots upstream's columnar `daily` object into one record per day.
 * Indexes every array against `time`'s length and tolerates a short/missing
 * array by yielding null for that field — the response is never assumed to
 * have equal-length columns just because it always has so far.
 */
function pivotDaily(daily: Record<string, (number | string | null)[]> | undefined): GlobalWeatherDailyResult[] {
  const times = daily?.time;
  if (!Array.isArray(times)) {
    return [];
  }
  const column = (name: string): (number | string | null)[] => {
    const values = daily?.[name];
    return Array.isArray(values) ? values : [];
  };
  return times.map((date, index) => ({
    date: toStringOrNull(date),
    weather: decodeWeatherCode(column("weather_code")[index]),
    temperatureMaxC: toNumber(column("temperature_2m_max")[index]),
    temperatureMinC: toNumber(column("temperature_2m_min")[index]),
    apparentTemperatureMaxC: toNumber(column("apparent_temperature_max")[index]),
    apparentTemperatureMinC: toNumber(column("apparent_temperature_min")[index]),
    sunrise: toStringOrNull(column("sunrise")[index]),
    sunset: toStringOrNull(column("sunset")[index]),
    precipitationSumMm: toNumber(column("precipitation_sum")[index]),
    precipitationProbabilityMaxPercent: toNumber(column("precipitation_probability_max")[index]),
    windSpeedMaxKmh: toNumber(column("wind_speed_10m_max")[index])
  }));
}

function toCurrentResult(current: Record<string, number | string | null> | undefined): GlobalWeatherCurrentResult | null {
  if (current === undefined) {
    return null;
  }
  const isDayRaw = toNumber(current.is_day);
  return {
    time: toStringOrNull(current.time),
    temperatureC: toNumber(current.temperature_2m),
    apparentTemperatureC: toNumber(current.apparent_temperature),
    relativeHumidityPercent: toNumber(current.relative_humidity_2m),
    precipitationMm: toNumber(current.precipitation),
    rainMm: toNumber(current.rain),
    showersMm: toNumber(current.showers),
    snowfallCm: toNumber(current.snowfall),
    cloudCoverPercent: toNumber(current.cloud_cover),
    pressureMslHpa: toNumber(current.pressure_msl),
    windSpeedKmh: toNumber(current.wind_speed_10m),
    windDirectionDegrees: toNumber(current.wind_direction_10m),
    windGustsKmh: toNumber(current.wind_gusts_10m),
    isDay: isDayRaw === null ? null : isDayRaw === 1,
    weather: decodeWeatherCode(current.weather_code)
  };
}

export const openMeteoForecastEntry: DatasetEntry<
  GlobalWeatherParams,
  OpenMeteoForecastRawResponse,
  GlobalWeatherResult
> = {
  id: "openmeteo:forecast",
  source: "openmeteo",
  path: OPEN_METEO_FORECAST_PATH,
  title: "全球天氣預報（依經緯度座標，台灣以外地區適用）",
  keywords: [
    "國外天氣",
    "海外天氣",
    "全球天氣",
    "世界天氣",
    "外國天氣",
    "經緯度天氣",
    "座標天氣",
    "global weather",
    "world weather",
    "international forecast",
    "open-meteo"
  ],
  paramsSchema: globalWeatherInputShape,
  buildQueryParams: params => ({
    latitude: String(params.latitude),
    longitude: String(params.longitude),
    current: OPEN_METEO_CURRENT_VARIABLES.join(","),
    daily: OPEN_METEO_DAILY_VARIABLES.join(","),
    // Always sent. Without it upstream silently answers in GMT while still
    // returning offset-less timestamps — see this module's comment (3).
    timezone: "auto",
    forecast_days: String(params.forecastDays ?? OPEN_METEO_DEFAULT_FORECAST_DAYS)
  }),
  transform: (raw, params) => {
    const daily = pivotDaily(raw.daily);
    const current = toCurrentResult(raw.current);
    const codes = [current?.weather.code, ...daily.map(day => day.weather.code)];
    const hasRegionalThunderstormCode = codes.some(code => code !== null && code !== undefined && REGIONAL_THUNDERSTORM_CODES.has(code));
    return {
      requested: {
        latitude: params.latitude,
        longitude: params.longitude,
        forecastDays: params.forecastDays ?? OPEN_METEO_DEFAULT_FORECAST_DAYS
      },
      resolved: {
        latitude: toNumber(raw.latitude),
        longitude: toNumber(raw.longitude),
        elevationM: toNumber(raw.elevation)
      },
      timezone: toStringOrNull(raw.timezone),
      timezoneAbbreviation: toStringOrNull(raw.timezone_abbreviation),
      utcOffsetSeconds: toNumber(raw.utc_offset_seconds),
      current,
      daily,
      attribution: OPEN_METEO_ATTRIBUTION,
      ...(hasRegionalThunderstormCode ? { weatherCodeNote: WMO_THUNDERSTORM_CODES_REGIONAL_NOTE } : {})
    };
  },
  cacheTtlSeconds: OPEN_METEO_FORECAST_CACHE_TTL_SECONDS,
  updateFrequency:
    "上游回應自行回報 current.interval = 900 秒（每 15 分鐘更新一次，非本伺服器推測），本伺服器快取 TTL 即依此設定。",
  docUrl: OPEN_METEO_FORECAST_DOC_URL,
  notes:
    "資料來源：Open-Meteo.com，**非官方氣象機關**——它是第三方服務，彙整並內插各國氣象單位的數值預報模式輸出" +
    "（DWD ICON、NOAA HRRR、Météo-France AROME 等），因此回傳值不一定等同任何一國官方發布的預報數字。" +
    "授權為 CC BY 4.0（與本伺服器其他來源的政府資料開放授權條款第 1 版不同），免費方案僅限非商業用途。" +
    "上游會把查詢座標吸附到模式網格點（例如 35.6785 → 35.7），回應同時附上 requested 與 resolved 兩組座標。" +
    "所有時間欄位不帶時區位移，須搭配同一筆回應的 timezone／utcOffsetSeconds 判讀。" +
    "天氣代碼為 WMO 代碼，對照文字逐字轉錄自 Open-Meteo 官方文件表格（description 欄），中文為本伺服器翻譯" +
    "（descriptionZh 欄），查無對照的代碼一律保留原始數字、不自行臆測文字。",
  sampleParams: { latitude: 35.6785, longitude: 139.6823, forecastDays: 3 },
  fixtureFileName: "openmeteo-forecast.json"
};

registerEntry(openMeteoForecastEntry as unknown as DatasetEntry<never, unknown, unknown>);

// --- openmeteo:geocoding — place name -> coordinates ---
//
// Registered as a REGISTRY-ONLY entry (reachable through tw_query_dataset),
// deliberately NOT given its own curated tool. Rationale, per
// docs/ARCHITECTURE.md §0's "工具數量與回應長度都有預算上限，寧可精不可多"
// and §3.2's long-tail model: name resolution is a one-line lookup that a
// calling LLM usually does not need at all (it already knows a major city's
// coordinates), and spending one of the ≤15 curated slots plus a tool
// definition's token cost on it — permanently, for every request — to save
// an occasional round trip is the wrong trade. Registering it keeps it
// fully available for the cases that DO need it (small towns, ambiguous or
// non-English names) at zero cost to callers who don't.
//
// Real structure confirmed 2026-08-11 the same way as the forecast entry:
//
//   { "generationtime_ms": 0.66,
//     "results": [ { "id": 1850147, "name": "Tokyo",
//                    "latitude": 35.6895, "longitude": 139.69171,
//                    "elevation": 44.0, "feature_code": "PPLC",
//                    "country_code": "JP", "country": "Japan",
//                    "admin1": "Tokyo", "timezone": "Asia/Tokyo",
//                    "population": 9733276, ... } ] }
//
// **The `results` key is ABSENT ENTIRELY when nothing matches** — a real
// no-match probe returned exactly `{"generationtime_ms": 0.42831898}`, not
// `{"results": []}`. Reading `raw.results.length` would throw on the very
// case a caller is most likely to hit (a misspelled place), so the
// transform treats a missing key and an empty array identically.
//
// `language` is honored for the returned NAMES too, not just matching: a
// `language=zh` query for 東京 came back with `"name": "東京"`,
// `"country": "日本"`, `"admin1": "东京都"` (upstream mixes traditional and
// simplified in that field — passed through verbatim, not "corrected").
export const geocodingInputShape = {
  name: z
    .string()
    .min(1)
    .describe("要查詢的地名（例如「Tokyo」「東京」「Reykjavik」）。支援多種語言，可搭配 language 參數。"),
  count: z
    .number()
    .int()
    .min(1)
    .max(OPEN_METEO_GEOCODING_MAX_RESULTS)
    .optional()
    .describe(`選填，最多回傳幾筆相符地點（1 到 ${OPEN_METEO_GEOCODING_MAX_RESULTS}，預設 ${OPEN_METEO_GEOCODING_DEFAULT_RESULTS}）。`),
  language: z
    .string()
    .min(2)
    .max(5)
    .optional()
    .describe("選填，回傳地名所使用的語言代碼（例如「zh」「en」「ja」）。預設 en。")
};

export interface GeocodingParams {
  name: string;
  count?: number;
  language?: string;
}

export interface OpenMeteoGeocodingRawRecord {
  id?: number;
  name?: string;
  latitude?: number;
  longitude?: number;
  elevation?: number;
  feature_code?: string;
  country_code?: string;
  country?: string;
  admin1?: string;
  timezone?: string;
  population?: number;
}

export interface OpenMeteoGeocodingRawResponse {
  /** Absent (not empty) when nothing matched — see this entry's module comment. */
  results?: OpenMeteoGeocodingRawRecord[];
  generationtime_ms?: number;
}

export interface GeocodingPlaceResult {
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  elevationM: number | null;
  country: string | null;
  countryCode: string | null;
  admin1: string | null;
  timezone: string | null;
  population: number | null;
}

export interface GeocodingResult {
  [key: string]: unknown;
  query: { name: string; count: number; language: string };
  places: GeocodingPlaceResult[];
  attribution: string;
}

export const openMeteoGeocodingEntry: DatasetEntry<
  GeocodingParams,
  OpenMeteoGeocodingRawResponse,
  GeocodingResult
> = {
  id: "openmeteo:geocoding",
  source: "openmeteo",
  path: OPEN_METEO_GEOCODING_PATH,
  title: "全球地名轉經緯度座標（Geocoding）",
  keywords: [
    "地名查座標",
    "geocoding",
    "經緯度查詢",
    "城市座標",
    "place lookup",
    "coordinates",
    "open-meteo"
  ],
  paramsSchema: geocodingInputShape,
  buildQueryParams: params => ({
    name: params.name,
    count: String(params.count ?? OPEN_METEO_GEOCODING_DEFAULT_RESULTS),
    language: params.language ?? "en",
    format: "json"
  }),
  transform: (raw, params) => ({
    query: {
      name: params.name,
      count: params.count ?? OPEN_METEO_GEOCODING_DEFAULT_RESULTS,
      language: params.language ?? "en"
    },
    // `?? []` is load-bearing, not defensive padding: upstream omits the
    // key entirely on a no-match (confirmed by a real probe).
    places: (raw.results ?? []).map(record => ({
      name: toStringOrNull(record.name),
      latitude: toNumber(record.latitude),
      longitude: toNumber(record.longitude),
      elevationM: toNumber(record.elevation),
      country: toStringOrNull(record.country),
      countryCode: toStringOrNull(record.country_code),
      admin1: toStringOrNull(record.admin1),
      timezone: toStringOrNull(record.timezone),
      population: toNumber(record.population)
    })),
    attribution: OPEN_METEO_ATTRIBUTION
  }),
  cacheTtlSeconds: OPEN_METEO_GEOCODING_CACHE_TTL_SECONDS,
  updateFrequency: "地點座標本質上是靜態資料，本伺服器快取 24 小時。",
  docUrl: OPEN_METEO_GEOCODING_DOC_URL,
  notes:
    "資料來源：Open-Meteo.com 的 Geocoding API（與天氣預報 API 位於不同主機），授權同為 CC BY 4.0、" +
    "免費方案僅限非商業用途。查無相符地點時，上游回應會完全沒有 results 這個鍵（不是空陣列），" +
    "本伺服器一律正規化為空的 places 陣列。搭配 openmeteo:forecast 使用：先用這筆查出座標，再查天氣。",
  sampleParams: { name: "Tokyo", count: 3, language: "en" },
  fixtureFileName: "openmeteo-geocoding.json"
};

registerEntry(openMeteoGeocodingEntry as unknown as DatasetEntry<never, unknown, unknown>);
