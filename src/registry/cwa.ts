import { z } from "zod";
import {
  E_A0015_001_DATASET_ID,
  F_A0021_001_DATASET_ID,
  F_C0032_001_DATASET_ID,
  O_A0001_001_DATASET_ID,
  O_A0005_001_DATASET_ID,
  STATION_OBSERVATION_CACHE_TTL_SECONDS,
  TAIWAN_CITIES,
  TYPHOON_NEWS_CACHE_TTL_SECONDS,
  TYPHOON_WARNING_CACHE_TTL_SECONDS,
  UV_DAILY_MAX_CACHE_TTL_SECONDS,
  WEATHER_CACHE_TTL_SECONDS,
  EARTHQUAKE_CACHE_TTL_SECONDS,
  TIDE_FORECAST_CACHE_TTL_SECONDS,
  W_C0033_001_DATASET_ID,
  W_C0034_001_DATASET_ID,
  W_C0034_005_DATASET_ID,
  WEATHER_WARNING_CACHE_TTL_SECONDS
} from "../constants.js";
import { ToolError } from "../infra/errors.js";
import type { CwaEarthquake, CwaEarthquakeRecords, CwaForecastLocation, CwaForecastRecords } from "../types.js";
import { registerEntry, type DatasetEntry } from "./index.js";

// --- F-C0032-001: 36-hour weather forecast ---

export const weatherForecastInputShape = {
  city: z
    .enum(TAIWAN_CITIES)
    .describe(
      "台灣縣市名稱（22 縣市之一），必須使用中央氣象署的標準全形字，例如「臺北市」「臺中市」「臺東縣」" +
        "（注意是「臺」，不是常見的「台」）。"
    )
};

export interface WeatherForecastParams {
  city: string;
}

export interface ForecastPeriod {
  startTime: string;
  endTime: string;
  weather: string;
  rainProbabilityPercent: number | null;
  minTemperatureC: number | null;
  maxTemperatureC: number | null;
  comfortIndex: string | null;
}

export interface WeatherForecastResult {
  [key: string]: unknown;
  city: string;
  periods: ForecastPeriod[];
}

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function extractPeriods(location: CwaForecastLocation): ForecastPeriod[] {
  const byElement = new Map(location.weatherElement.map(element => [element.elementName, element]));
  const wx = byElement.get("Wx");
  const periodCount = wx?.time.length ?? 0;

  const periods: ForecastPeriod[] = [];
  for (let i = 0; i < periodCount; i++) {
    const wxTime = wx!.time[i];
    periods.push({
      startTime: wxTime.startTime,
      endTime: wxTime.endTime,
      weather: wxTime.parameter.parameterName,
      rainProbabilityPercent: toNumberOrNull(byElement.get("PoP")?.time[i]?.parameter.parameterName),
      minTemperatureC: toNumberOrNull(byElement.get("MinT")?.time[i]?.parameter.parameterName),
      maxTemperatureC: toNumberOrNull(byElement.get("MaxT")?.time[i]?.parameter.parameterName),
      comfortIndex: byElement.get("CI")?.time[i]?.parameter.parameterName ?? null
    });
  }
  return periods;
}

export const weatherForecastEntry: DatasetEntry<WeatherForecastParams, CwaForecastRecords, WeatherForecastResult> = {
  id: "cwa:F-C0032-001",
  source: "cwa",
  path: F_C0032_001_DATASET_ID,
  title: "今明 36 小時天氣預報",
  keywords: ["天氣", "預報", "氣溫", "降雨", "降雨機率", "舒適度", "weather", "forecast"],
  paramsSchema: weatherForecastInputShape,
  buildQueryParams: params => ({ locationName: params.city }),
  transform: (raw, params) => {
    const location = raw.location.find(l => l.locationName === params.city);
    if (!location) {
      throw new ToolError({
        code: "NOT_FOUND",
        message: `中央氣象署沒有回傳「${params.city}」的預報資料。請確認縣市名稱是否正確（需使用「臺」而非「台」，例如「臺北市」）。`
      });
    }
    return { city: params.city, periods: extractPeriods(location) };
  },
  cacheTtlSeconds: WEATHER_CACHE_TTL_SECONDS,
  updateFrequency: "每日數次",
  docUrl: "https://opendata.cwa.gov.tw/dataset/forecast/F-C0032-001",
  sampleParams: { city: "臺北市" },
  fixtureFileName: "weather-forecast.json"
};

// --- E-A0015-001: significant earthquake reports ---

export const recentEarthquakesInputShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe("要回傳的地震報告筆數，範圍 1-10，預設 3 筆，依發生時間新到舊排序。")
};

export interface RecentEarthquakesParams {
  limit: number;
}

/** CWA intensity scale, ordered weakest to strongest, for picking the max-intensity area. */
const INTENSITY_ORDER = ["0級", "1級", "2級", "3級", "4級", "5弱", "5強", "6弱", "6強", "7級"];

function intensityRank(intensity: string | undefined): number {
  if (!intensity) return -1;
  return INTENSITY_ORDER.indexOf(intensity);
}

export interface EarthquakeSummary {
  earthquakeNo: number;
  originTime: string;
  /** When CWA published this report (may differ from originTime by a few minutes). Not confirmed always present, so nullable like detailUrl. */
  issuedAt: string | null;
  /** When this report's validity period ends — after this, a later/updated report may supersede it. */
  validUntil: string | null;
  magnitude: number;
  magnitudeType: string;
  depthKm: number;
  epicenter: string;
  maxIntensity: string;
  reportContent: string;
  detailUrl: string | null;
}

function summarizeEarthquake(earthquake: CwaEarthquake): EarthquakeSummary {
  const areas = earthquake.Intensity?.ShakingArea ?? [];
  const maxIntensity = areas.reduce<string>((max, area) => {
    return intensityRank(area.AreaIntensity) > intensityRank(max) ? area.AreaIntensity : max;
  }, areas[0]?.AreaIntensity ?? "無資料");

  return {
    earthquakeNo: earthquake.EarthquakeNo,
    originTime: earthquake.EarthquakeInfo.OriginTime,
    issuedAt: earthquake.IssueTime ?? null,
    validUntil: earthquake.ValidTime?.EndTime ?? null,
    magnitude: earthquake.EarthquakeInfo.EarthquakeMagnitude.MagnitudeValue,
    magnitudeType: earthquake.EarthquakeInfo.EarthquakeMagnitude.MagnitudeType,
    depthKm: earthquake.EarthquakeInfo.FocalDepth,
    epicenter: earthquake.EarthquakeInfo.Epicenter.Location,
    maxIntensity,
    reportContent: earthquake.ReportContent,
    detailUrl: earthquake.Web ?? null
  };
}

export interface RecentEarthquakesResult {
  [key: string]: unknown;
  earthquakes: EarthquakeSummary[];
}

export const recentEarthquakesEntry: DatasetEntry<
  RecentEarthquakesParams,
  CwaEarthquakeRecords,
  RecentEarthquakesResult
> = {
  id: "cwa:E-A0015-001",
  source: "cwa",
  path: E_A0015_001_DATASET_ID,
  title: "顯著有感地震報告",
  keywords: ["地震", "顯著有感", "震度", "規模", "earthquake"],
  paramsSchema: recentEarthquakesInputShape,
  buildQueryParams: params => ({ limit: String(params.limit) }),
  transform: (raw, params) => {
    const earthquakes = (raw.Earthquake ?? []).slice(0, params.limit).map(summarizeEarthquake);
    return { earthquakes };
  },
  cacheTtlSeconds: EARTHQUAKE_CACHE_TTL_SECONDS,
  updateFrequency: "地震發生時即時發布",
  docUrl: "https://opendata.cwa.gov.tw/dataset/earthquake/E-A0015-001",
  notes: "僅涵蓋中央氣象署認定為「顯著有感」等級以上之地震，規模過小或有感範圍過小的地震可能未收錄於此資料集。",
  sampleParams: { limit: 3 },
  fixtureFileName: "earthquakes.json"
};

// --- F-A0021-001: tide forecast (generic-layer only — no curated tool yet) ---
//
// Confirmed to exist and still maintained (opendata.cwa.gov.tw/dataset/
// observation/F-A0021-001, "潮汐預報(未來1個月潮汐預報，鄉鎮、大潮小潮、
// 滿潮乾潮、時間、潮高)"). Structure below is confirmed 2026-07-21 via a real
// dispatch of fixtures-refresh.yml against the live API — an earlier version
// of this entry was reconstructed from a 2020-vintage real response
// committed as a test fixture in a third-party CWA client library
// (go-cwb), which turned out to be stale: CWA has since restructured this
// dataset's top-level response entirely (`records.dataid`/`records.note`/
// `records.TideForecasts` now, not `records.datasetDescription`/
// `records.location`). The real response also confirmed that, like
// aqx_p_432, the `locationName` filter isn't honored upstream — the API
// returns all ~266 locations nationwide regardless of the query param, so
// `transform` re-filters client-side the same way aqx_p_432 already does.
// `transform` stays deliberately shallow — it passes each day's `Time`
// array through close to as-is rather than deep-extracting individual
// tide-height fields, since those aren't load-bearing for any curated tool
// yet.

export const tideForecastInputShape = {
  locationName: z
    .string()
    .min(1)
    .describe(
      "潮汐預報地點名稱（通常為鄉鎮層級，例如「宜蘭縣南澳鄉」），須與中央氣象署潮汐預報地點清單完全相符，" +
        "本伺服器未內建完整地點清單。"
    )
};

export interface TideForecastParams {
  locationName: string;
}

interface CwaTideDaily {
  Date: string;
  LunarDate: string;
  /** 大潮/中潮/小潮, e.g. "大" | "中" | "小". */
  TideRange: string;
  Time: unknown[];
}

interface CwaTideLocation {
  LocationId: string;
  LocationName: string;
  Latitude: number;
  Longitude: number;
  TimePeriods: { Daily: CwaTideDaily[] };
}

interface CwaTideForecastEntry {
  Location: CwaTideLocation;
}

interface CwaTideRecords {
  dataid?: string;
  note?: string;
  TideForecasts?: CwaTideForecastEntry[];
}

export interface TideForecastResult {
  [key: string]: unknown;
  locationName: string;
  stationId: string;
  /** Raw per-day tide entries (CwaTideDaily[]), passed through close to as-is — see the module-level comment on why this isn't deep-extracted. */
  forecast: unknown[];
}

export const tideForecastEntry: DatasetEntry<TideForecastParams, CwaTideRecords, TideForecastResult> = {
  id: "cwa:F-A0021-001",
  source: "cwa",
  path: F_A0021_001_DATASET_ID,
  title: "潮汐預報（未來1個月）",
  keywords: ["潮汐", "潮汐預報", "漲潮", "退潮", "滿潮", "乾潮", "潮差", "大潮", "小潮", "tide", "tide forecast"],
  paramsSchema: tideForecastInputShape,
  buildQueryParams: params => ({ locationName: params.locationName }),
  transform: (raw, params) => {
    const entry = (raw.TideForecasts ?? []).find(e => e.Location?.LocationName === params.locationName);
    if (!entry) {
      throw new ToolError({
        code: "NOT_FOUND",
        message:
          `中央氣象署沒有回傳「${params.locationName}」的潮汐預報資料，請確認地點名稱是否為中央氣象署潮汐預報` +
          `清單中的正確全名（通常是鄉鎮層級，例如「宜蘭縣南澳鄉」）。`
      });
    }
    return {
      locationName: entry.Location.LocationName,
      stationId: entry.Location.LocationId,
      forecast: entry.Location.TimePeriods?.Daily ?? []
    };
  },
  cacheTtlSeconds: TIDE_FORECAST_CACHE_TTL_SECONDS,
  updateFrequency: "每月更新（提供未來 1 個月預報）",
  docUrl: "https://opendata.cwa.gov.tw/dataset/observation/F-A0021-001",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。欄位結構已於 2026-07-21 透過 fixtures-refresh.yml" +
    "真實 API 回應確認（records.TideForecasts[].Location.TimePeriods.Daily[]）。與 aqx_p_432 相同，" +
    "locationName 篩選條件在上游未必生效，故 transform 於前端重新篩選。",
  sampleParams: { locationName: "宜蘭縣南澳鄉" },
  fixtureFileName: "tide-forecast.json"
};

// --- O-A0001-001: automated weather station observations (generic-layer only) ---
//
// Confirmed to exist and still maintained (opendata.cwa.gov.tw/dataset/
// observation/O-A0001-001, "自動氣象站-氣象觀測資料"／"全測站逐時氣象資料").
// Structure below is confirmed 2026-07-21 via a real dispatch of
// fixtures-refresh.yml against the live API. An earlier version of this
// entry was built from real Go source code in a third-party CWA client
// library (go-cwb, cwb/station_obs.go — a 2017-vintage capture), which
// turned out stale the same way F-A0021-001's did: CWA has since
// restructured this dataset's top-level response entirely
// (`records.Station[]` now, not `records.location[]`; per-station fields
// are `StationName`/`StationId`/`ObsTime.DateTime`/`GeoInfo`/
// `WeatherElement` rather than the old flat elementName/elementValue
// pairs). Also confirmed: like aqx_p_432 and F-A0021-001, the `locationName`
// filter isn't honored upstream — the API returns all ~874 stations
// nationwide regardless of the query param, so `transform` re-filters
// client-side. `WeatherElement` stays a deliberately shallow pass-through
// (Weather/AirTemperature/RelativeHumidity/WindSpeed/DailyExtreme/etc. are
// not individually extracted) since none of it is load-bearing for any
// curated tool yet.

export const stationObservationInputShape = {
  locationName: z
    .string()
    .min(1)
    .describe(
      "氣象測站名稱（例如「合歡山」），須與中央氣象署自動氣象站清單完全相符，" + "本伺服器未內建完整測站清單。"
    )
};

export interface StationObservationParams {
  locationName: string;
}

interface CwaStationObsCoordinate {
  CoordinateName?: string;
  CoordinateFormat?: string;
  StationLatitude?: string;
  StationLongitude?: string;
}

interface CwaStationObsGeoInfo {
  Coordinates?: CwaStationObsCoordinate[];
  StationAltitude?: string;
  CountyName?: string;
  TownName?: string;
  CountyCode?: string;
  TownCode?: string;
}

interface CwaStationObs {
  StationName: string;
  StationId?: string;
  ObsTime?: { DateTime?: string };
  GeoInfo?: CwaStationObsGeoInfo;
  /** Nested weather measurements (Weather/AirTemperature/RelativeHumidity/WindSpeed/DailyExtreme/...), passed through as-is — see the module-level comment on why this isn't deep-extracted. */
  WeatherElement?: unknown;
}

interface CwaStationObsRecords {
  Station?: CwaStationObs[];
}

export interface StationObservationResult {
  [key: string]: unknown;
  locationName: string;
  stationId?: string;
  obsTime?: string;
  county?: string;
  town?: string;
  /** Raw nested weather measurements, passed through as-is — see CwaStationObs.WeatherElement. */
  weatherElement: unknown;
}

export const stationObservationEntry: DatasetEntry<StationObservationParams, CwaStationObsRecords, StationObservationResult> = {
  id: "cwa:O-A0001-001",
  source: "cwa",
  path: O_A0001_001_DATASET_ID,
  title: "自動氣象站氣象觀測資料",
  keywords: ["氣象觀測", "自動氣象站", "即時氣象", "測站資料", "溫度", "濕度", "風速", "weather observation", "station observation"],
  paramsSchema: stationObservationInputShape,
  buildQueryParams: params => ({ locationName: params.locationName }),
  transform: (raw, params) => {
    const station = (raw.Station ?? []).find(s => s.StationName === params.locationName);
    if (!station) {
      throw new ToolError({
        code: "NOT_FOUND",
        message: `中央氣象署沒有回傳「${params.locationName}」測站的觀測資料，請確認測站名稱是否正確（例如「合歡山」）。`
      });
    }
    return {
      locationName: station.StationName,
      stationId: station.StationId,
      obsTime: station.ObsTime?.DateTime,
      county: station.GeoInfo?.CountyName,
      town: station.GeoInfo?.TownName,
      weatherElement: station.WeatherElement ?? {}
    };
  },
  cacheTtlSeconds: STATION_OBSERVATION_CACHE_TTL_SECONDS,
  updateFrequency: "每小時整點觀測（確切發布頻率未經驗證）",
  docUrl: "https://opendata.cwa.gov.tw/dataset/observation/O-A0001-001",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。欄位結構已於 2026-07-21 透過 fixtures-refresh.yml" +
    "真實 API 回應確認（records.Station[].{StationName,StationId,ObsTime,GeoInfo,WeatherElement}）。與" +
    "aqx_p_432、F-A0021-001 相同，locationName 篩選條件在上游未必生效（會回傳全國約 874 個測站），故" +
    "transform 於前端重新篩選。",
  sampleParams: { locationName: "合歡山" },
  fixtureFileName: "station-observation.json"
};

// --- W-C0033-001: weather warnings (generic-layer only) ---
//
// Confirmed to exist and still maintained (opendata.cwa.gov.tw/dataset/
// warning/W-C0033-001, "天氣特報-各別縣市地區目前之天氣警特報情形"). This was
// skipped in an earlier session for lack of field evidence (go-cwb doesn't
// implement it, and no official doc or captured sample could be found), so
// it was first registered as a minimal pass-through skeleton and then
// resolved via a real dispatch of fixtures-refresh.yml (2026-07-21), which
// captured the actual shape: `records.location[]`, one entry per one of
// Taiwan's 22 counties/cities (matching TAIWAN_CITIES exactly), each with
// `hazardConditions.hazards[]` (empty array when no active warning for that
// county). No filter param is sent — the real dispatch fetched with none
// and got back all 22 counties, so `transform` filters client-side by
// `county` rather than guessing an unconfirmed upstream filter param name.

export const weatherWarningInputShape = {
  county: z
    .enum(TAIWAN_CITIES)
    .optional()
    .describe("縣市名稱（台灣 22 縣市之一），只回傳該縣市的天氣特報狀態。不填則回傳全部縣市。須用「臺」而非「台」。")
};

export interface WeatherWarningParams {
  county?: string;
}

interface CwaWeatherWarningHazard {
  info: { language: string; phenomena: string; significance: string };
  validTime: { startTime: string; endTime: string };
}

interface CwaWeatherWarningLocation {
  locationName: string;
  geocode: number;
  hazardConditions?: { hazards: CwaWeatherWarningHazard[] };
}

interface CwaWeatherWarningRecords {
  location?: CwaWeatherWarningLocation[];
}

export interface WeatherWarningCounty {
  county: string;
  hazards: Array<{ phenomena: string; significance: string; startTime: string; endTime: string }>;
}

export interface WeatherWarningResult {
  [key: string]: unknown;
  query: { county?: string };
  counties: WeatherWarningCounty[];
}

export const weatherWarningEntry: DatasetEntry<WeatherWarningParams, CwaWeatherWarningRecords, WeatherWarningResult> = {
  id: "cwa:W-C0033-001",
  source: "cwa",
  path: W_C0033_001_DATASET_ID,
  title: "天氣特報",
  keywords: ["天氣特報", "特報", "警特報", "豪雨特報", "強風特報", "低溫特報", "陸上颱風警報", "weather warning", "weather alert"],
  paramsSchema: weatherWarningInputShape,
  buildQueryParams: () => ({}),
  transform: (raw, params) => {
    const locations = params.county ? (raw.location ?? []).filter(l => l.locationName === params.county) : (raw.location ?? []);
    return {
      query: params.county ? { county: params.county } : {},
      counties: locations.map(l => ({
        county: l.locationName,
        hazards: (l.hazardConditions?.hazards ?? []).map(h => ({
          phenomena: h.info.phenomena,
          significance: h.info.significance,
          startTime: h.validTime.startTime,
          endTime: h.validTime.endTime
        }))
      }))
    };
  },
  cacheTtlSeconds: WEATHER_WARNING_CACHE_TTL_SECONDS,
  updateFrequency: "特報發布/解除時即時更新",
  docUrl: "https://opendata.cwa.gov.tw/dataset/warning/W-C0033-001",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。欄位結構已於 2026-07-21 透過 fixtures-refresh.yml" +
    "真實 API 回應確認。回應固定涵蓋全部 22 縣市（無論是否有生效中的特報，hazards 陣列可能為空），" +
    "故不送任何篩選參數，一律於前端依 county 篩選。",
  sampleParams: {},
  fixtureFileName: "weather-warning.json"
};

// --- F-A0012-001: marine weather forecast — NOT registered ---
//
// Confirmed to exist as a catalog listing (opendata.cwa.gov.tw/dataset/
// forecast/F-A0012-001; official product doc title "海象_遠海漁業／近海漁業
// 氣象預報" — opendata.cwa.gov.tw/opendatadoc/Forecast/F-A0012.pdf), and was
// first registered as a minimal pass-through skeleton, same as W-C0033-001.
// A real dispatch of fixtures-refresh.yml (2026-07-21) fetched it via this
// codebase's uniform CWA datastore endpoint (buildCwaUrl → GET
// /api/v1/rest/datastore/F-A0012-001) and got back a real HTTP 404
// ("Resource not found"), not a sandbox network block. Root cause: per
// further research, this specific dataset is served through CWA's older
// `/fileapi/v1/opendataapi/{id}` endpoint (matching its primary format
// being a text bulletin, XML secondary), not the `/api/v1/rest/datastore/`
// JSON REST endpoint every other entry in this file uses. Supporting it
// would need a second, dataset-specific fetch path in the CWA adapter —
// out of scope for a registry entry, so this candidate is deliberately
// NOT registered rather than kept as a permanently-broken skeleton. See
// the PR that added this comment for the full investigation.

// --- O-A0005-001: daily maximum UV index (generic-layer only) ---
//
// Confirmed to exist (title "紫外線指數-每日紫外線指數最大值" per search-engine
// snippets referencing opendata.cwa.gov.tw/dataset/observation/O-A0005-001).
// This was skipped in an earlier session for lack of field/query-param
// evidence, then registered as a minimal pass-through skeleton, then
// resolved via a real dispatch of fixtures-refresh.yml (2026-07-21), which
// confirmed the categorization question flagged back then: CWA's catalog
// puts this dataset under **"observation"**, not "forecast", and the real
// response is exactly that — a same-day snapshot (`records.weatherElement`
// is a single object, not an array, with a `Date` field for "today" and a
// `location[]` list of every station's running daily-max UV reading so
// far), not a forward-looking multi-day forecast. Each station entry is
// only `{ StationID, UVIndex }` — no station name — so filtering is by
// `stationId`, not a human-readable location name; a real station name can
// be cross-referenced via cwa:O-A0001-001 (自動氣象站氣象觀測資料), whose
// `StationId` values follow the same numbering. No filter param is sent —
// the real dispatch fetched with none and got back every station.

export const uvDailyMaxInputShape = {
  stationId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "氣象測站代碼（例如「467490」），不填則回傳所有測站當日紫外線指數最大值。" +
        "本伺服器未內建測站代碼對照表，可另外透過 cwa:O-A0001-001（自動氣象站氣象觀測資料）查得測站清單後比對。"
    )
};

export interface UvDailyMaxParams {
  stationId?: string;
}

interface CwaUvDailyMaxStation {
  StationID: string;
  UVIndex: number;
}

interface CwaUvDailyMaxWeatherElement {
  elementName?: string;
  location?: CwaUvDailyMaxStation[];
  Date?: string;
}

interface CwaUvDailyMaxRecords {
  weatherElement?: CwaUvDailyMaxWeatherElement;
}

export interface UvDailyMaxResult {
  [key: string]: unknown;
  date?: string;
  query: { stationId?: string };
  stations: Array<{ stationId: string; uvIndex: number }>;
}

export const uvDailyMaxEntry: DatasetEntry<UvDailyMaxParams, CwaUvDailyMaxRecords, UvDailyMaxResult> = {
  id: "cwa:O-A0005-001",
  source: "cwa",
  path: O_A0005_001_DATASET_ID,
  title: "紫外線指數每日最大值",
  keywords: ["紫外線", "紫外線指數", "UV", "UVI", "每日最大值", "daily max uv", "uv index"],
  paramsSchema: uvDailyMaxInputShape,
  buildQueryParams: () => ({}),
  transform: (raw, params) => {
    const stations = raw.weatherElement?.location ?? [];
    const matched = params.stationId ? stations.filter(s => s.StationID === params.stationId) : stations;
    return {
      date: raw.weatherElement?.Date,
      query: params.stationId ? { stationId: params.stationId } : {},
      stations: matched.map(s => ({ stationId: s.StationID, uvIndex: s.UVIndex }))
    };
  },
  cacheTtlSeconds: UV_DAILY_MAX_CACHE_TTL_SECONDS,
  updateFrequency: "當日持續更新中的滾動最大值（官方分類為「觀測」而非「預報」，見上方模組註解）",
  docUrl: "https://opendata.cwa.gov.tw/dataset/observation/O-A0005-001",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。欄位結構已於 2026-07-21 透過 fixtures-refresh.yml" +
    "真實 API 回應確認。此資料集官方分類為「觀測」，回應是當日至今的滾動每日最大值快照（非未來預報），" +
    "每筆只有測站代碼、沒有測站名稱，篩選以 stationId 而非地點名稱進行。",
  sampleParams: {},
  fixtureFileName: "uv-daily-max.json"
};

// --- W-C0034-005: typhoon news/bulletin (powers tw_typhoon) ---
//
// Confirmed to exist and still maintained (data.gov.tw catalog entry
// "颱風消息與警報-颱風消息", official description: "西北太平洋地區及南海目前
// 所有活動中熱帶氣旋之資訊-熱帶性低氣壓及颱風過去、現在及未來預報之資訊",
// updated every 6 hours while a tropical cyclone is active). Structure below
// is confirmed 2026-07-21 via a real dispatch of fixtures-refresh.yml
// against the live API: `records.TropicalCyclones.TropicalCyclone[]`, one
// entry per active system in the NW Pacific/South China Sea (not just ones
// threatening Taiwan — see tw_typhoon's tool description for this scope
// caveat). Each entry has `AnalysisData.Fix[]` (past+current observed
// positions) and `ForecastData.Fix[]` (CWA's own future track forecast
// points, keyed by ForecastHour) — both transcribed as-is, never generated
// or extrapolated by this server. Important: `TyphoonName`/`CwaTyphoonName`/
// `CwaTyNo` are only present once CWA has upgraded and named the system —
// a weaker system (tropical depression) only has `CwaTdNo`, which the real
// capture confirms (see test/fixtures/typhoon-news.json). This is the
// dataset selected to power tw_typhoon (rather than W-C0034-001 below)
// because it's the one that actually carries name/position/track data;
// W-C0034-001 is the separate "which areas are under a warning right now"
// text bulletin.

export const typhoonNewsInputShape = {};

export type TyphoonNewsParams = Record<string, never>;

interface CwaTyphoonAnalysisFix {
  DateTime?: string;
  CoordinateLongitude?: string;
  CoordinateLatitude?: string;
  MaxWindSpeed?: string;
  MaxGustSpeed?: string;
  Pressure?: string;
  MovingSpeed?: string;
  MovingDirection?: string;
}

interface CwaTyphoonForecastFix {
  InitialTime?: string;
  ForecastHour?: string;
  CoordinateLongitude?: string;
  CoordinateLatitude?: string;
  MaxWindSpeed?: string;
  MaxGustSpeed?: string;
  Pressure?: string;
  MovingSpeed?: string;
  MovingDirection?: string;
}

interface CwaTropicalCyclone {
  Year?: string;
  TyphoonName?: string;
  CwaTyphoonName?: string;
  CwaTdNo?: string;
  CwaTyNo?: string;
  AnalysisData?: { Fix?: CwaTyphoonAnalysisFix[] };
  ForecastData?: { Fix?: CwaTyphoonForecastFix[] };
}

interface CwaTyphoonNewsRecords {
  dataid?: string;
  note?: string;
  TropicalCyclones?: { TropicalCyclone?: CwaTropicalCyclone[] };
}

function toNumberOrNullTyphoon(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

export interface TyphoonTrackPoint {
  [key: string]: unknown;
  time: string | null;
  longitude: number | null;
  latitude: number | null;
  maxWindSpeedMs: number | null;
  maxGustSpeedMs: number | null;
  pressureHpa: number | null;
}

export interface TyphoonForecastPoint extends TyphoonTrackPoint {
  forecastHour: number | null;
}

export interface TyphoonSummary {
  [key: string]: unknown;
  /** CWA's official Chinese name once assigned; null while still an unnamed tropical depression. */
  name: string | null;
  /** International (English) name once assigned; null while still an unnamed tropical depression. */
  internationalName: string | null;
  /** True once CWA has upgraded and named this system as a typhoon; false while it's still just a numbered tropical depression. */
  isNamedTyphoon: boolean;
  /** CWA's typhoon number (颱風編號) once named, else its tropical-depression number (熱帶性低氣壓編號). */
  cwaNumber: string | null;
  /** Most recent observed position — the last entry in AnalysisData.Fix, transcribed as-is. */
  latestPosition: TyphoonTrackPoint | null;
  /** CWA's own forecast track points, transcribed as-is — never generated or extrapolated by this server. */
  forecastTrack: TyphoonForecastPoint[];
}

export interface TyphoonNewsResult {
  [key: string]: unknown;
  hasActiveSystem: boolean;
  typhoons: TyphoonSummary[];
}

function summarizeAnalysisFix(fix: CwaTyphoonAnalysisFix): TyphoonTrackPoint {
  return {
    time: fix.DateTime ?? null,
    longitude: toNumberOrNullTyphoon(fix.CoordinateLongitude),
    latitude: toNumberOrNullTyphoon(fix.CoordinateLatitude),
    maxWindSpeedMs: toNumberOrNullTyphoon(fix.MaxWindSpeed),
    maxGustSpeedMs: toNumberOrNullTyphoon(fix.MaxGustSpeed),
    pressureHpa: toNumberOrNullTyphoon(fix.Pressure)
  };
}

function summarizeForecastFix(fix: CwaTyphoonForecastFix): TyphoonForecastPoint {
  return {
    ...summarizeAnalysisFix(fix),
    time: fix.InitialTime ?? null,
    forecastHour: toNumberOrNullTyphoon(fix.ForecastHour)
  };
}

function summarizeTropicalCyclone(cyclone: CwaTropicalCyclone): TyphoonSummary {
  const analysisFixes = cyclone.AnalysisData?.Fix ?? [];
  const latestAnalysisFix = analysisFixes[analysisFixes.length - 1];
  return {
    name: cyclone.CwaTyphoonName ?? null,
    internationalName: cyclone.TyphoonName ?? null,
    isNamedTyphoon: Boolean(cyclone.CwaTyphoonName || cyclone.TyphoonName),
    cwaNumber: cyclone.CwaTyNo ?? cyclone.CwaTdNo ?? null,
    latestPosition: latestAnalysisFix ? summarizeAnalysisFix(latestAnalysisFix) : null,
    forecastTrack: (cyclone.ForecastData?.Fix ?? []).map(summarizeForecastFix)
  };
}

export const typhoonNewsEntry: DatasetEntry<TyphoonNewsParams, CwaTyphoonNewsRecords, TyphoonNewsResult> = {
  id: "cwa:W-C0034-005",
  source: "cwa",
  path: W_C0034_005_DATASET_ID,
  title: "颱風消息",
  keywords: ["颱風", "颱風消息", "颱風動態", "颱風路徑", "颱風警報", "typhoon", "typhoon news", "typhoon track"],
  paramsSchema: typhoonNewsInputShape,
  buildQueryParams: () => ({}),
  transform: raw => {
    const cyclones = raw.TropicalCyclones?.TropicalCyclone ?? [];
    return {
      hasActiveSystem: cyclones.length > 0,
      typhoons: cyclones.map(summarizeTropicalCyclone)
    };
  },
  cacheTtlSeconds: TYPHOON_NEWS_CACHE_TTL_SECONDS,
  updateFrequency: "有熱帶氣旋活動時每 6 小時更新一次，無活動時不定期",
  docUrl: "https://opendata.cwa.gov.tw/dataset/all/W-C0034-005",
  notes:
    "欄位結構已於 2026-07-21 透過 fixtures-refresh.yml 真實 API 回應確認" +
    "（records.TropicalCyclones.TropicalCyclone[].{AnalysisData,ForecastData}）。轉載中央氣象署" +
    "已發布之分析與預測路徑點，本伺服器不自行計算或推測路徑。涵蓋整個西北太平洋與南海的熱帶氣旋" +
    "（含尚未達颱風強度、未命名的熱帶性低氣壓），不代表一定會侵襲台灣。",
  sampleParams: {},
  fixtureFileName: "typhoon-news.json"
};

// --- W-C0034-001: typhoon warning (generic-layer only) ---
//
// Confirmed to exist and still maintained (data.gov.tw catalog entry
// "颱風消息與警報-颱風警報"). Distinct from W-C0034-005 above (see that
// entry's comment for why the curated tool consumes 005, not this one) —
// this is CWA's official CAP-format (Common Alerting Protocol) "which areas
// are currently under a typhoon warning" bulletin. Structure confirmed
// 2026-07-21 via a real dispatch of fixtures-refresh.yml:
// `records.info[]`, each a full CAP alert object (headline/urgency/
// severity/certainty/effective/onset/expires/area[]/description). The real
// captured sample (test/fixtures/typhoon-warning.json) happened to be a
// "warning lifted" (解除颱風警報) bulletin, not an active warning — headline
// text alone signals that, so transform surfaces it verbatim rather than
// trying to infer an "isActive" boolean from urgency/severity/certainty
// (CAP's own vocabulary for those fields doesn't map cleanly to a simple
// active/inactive flag, and guessing that mapping risks exactly the kind of
// invented interpretation this server must not do for typhoon warnings).
// `description` is passed through mostly as-is — its internal `section`
// list is genuinely freeform bulletin text set per-alert by CWA, not a
// fixed schema safe to deep-parse.

export const typhoonWarningInputShape = {};

export type TyphoonWarningParams = Record<string, never>;

interface CwaCapArea {
  areaDesc?: string;
}

interface CwaCapAlert {
  language?: string;
  event?: string;
  urgency?: string;
  severity?: string;
  certainty?: string;
  effective?: string;
  onset?: string;
  expires?: string;
  senderName?: string;
  headline?: string;
  description?: unknown;
  web?: string;
  area?: CwaCapArea[];
}

interface CwaTyphoonWarningRecords {
  info?: CwaCapAlert[];
}

export interface TyphoonWarningSummary {
  [key: string]: unknown;
  headline: string | null;
  event: string | null;
  urgency: string | null;
  severity: string | null;
  certainty: string | null;
  effective: string | null;
  onset: string | null;
  expires: string | null;
  senderName: string | null;
  areas: string[];
  webUrl: string | null;
  /** Freeform bulletin text/sections, passed through as-is — see the module-level comment on why this isn't deep-parsed. */
  description: unknown;
}

export interface TyphoonWarningResult {
  [key: string]: unknown;
  bulletins: TyphoonWarningSummary[];
}

export const typhoonWarningEntry: DatasetEntry<TyphoonWarningParams, CwaTyphoonWarningRecords, TyphoonWarningResult> = {
  id: "cwa:W-C0034-001",
  source: "cwa",
  path: W_C0034_001_DATASET_ID,
  title: "颱風警報",
  keywords: ["颱風警報", "海上颱風警報", "陸上颱風警報", "颱風特報", "typhoon warning"],
  paramsSchema: typhoonWarningInputShape,
  buildQueryParams: () => ({}),
  transform: raw => ({
    bulletins: (raw.info ?? []).map(alert => ({
      headline: alert.headline ?? null,
      event: alert.event ?? null,
      urgency: alert.urgency ?? null,
      severity: alert.severity ?? null,
      certainty: alert.certainty ?? null,
      effective: alert.effective ?? null,
      onset: alert.onset ?? null,
      expires: alert.expires ?? null,
      senderName: alert.senderName ?? null,
      areas: (alert.area ?? []).map(a => a.areaDesc ?? "").filter(Boolean),
      webUrl: alert.web ?? null,
      description: alert.description ?? null
    }))
  }),
  cacheTtlSeconds: TYPHOON_WARNING_CACHE_TTL_SECONDS,
  updateFrequency: "颱風警報生效期間每小時更新一次，無警報時不定期",
  docUrl: "https://opendata.cwa.gov.tw/dataset/warning/W-C0034-001",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。欄位結構已於 2026-07-21 透過" +
    "fixtures-refresh.yml 真實 API 回應確認（CAP 格式，records.info[]）。headline 是否代表" +
    "「警報生效中」或「警報已解除」需自行判讀文字內容（例如「解除颱風警報」），本 transform 不做" +
    "額外的 isActive 推斷。",
  sampleParams: {},
  fixtureFileName: "typhoon-warning.json"
};

// --- O-B0076-001: marine observation stations (buoy/tide) — NOT registered ---
//
// Confirmed to exist as a catalog listing, title "海象觀測測站資料-浮標站與
// 潮位站測站資料" (real-time buoy/tide-station marine observations), and was
// first registered as a minimal pass-through skeleton to retry after
// F-A0012-001 (海面天氣預報) was dropped for a similar reason. A real
// dispatch of fixtures-refresh.yml (2026-07-21) fetched it via this
// codebase's uniform CWA datastore endpoint (buildCwaUrl → GET
// /api/v1/rest/datastore/O-B0076-001) and got back a real HTTP 404
// ("Resource not found"), not a sandbox network block — confirming the
// suspicion noted when this entry was first registered: CWA appears to run
// much of its marine/ocean data through a separate ocean.cwa.gov.tw/
// oceanapi.cwa.gov.tw platform with its own auth and dataset-code scheme,
// not the datastore API every other entry in this file uses. Same
// architectural incompatibility as F-A0012-001, same resolution: dropped
// rather than kept as a permanently-broken skeleton (constant, cache TTL,
// entry, tests, and fixture all removed). See the PR that added this
// comment for the full investigation.

registerEntry(weatherForecastEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(recentEarthquakesEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(tideForecastEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(stationObservationEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(weatherWarningEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(uvDailyMaxEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(typhoonNewsEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(typhoonWarningEntry as unknown as DatasetEntry<never, unknown, unknown>);
