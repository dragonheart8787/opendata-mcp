import { z } from "zod";
import {
  E_A0015_001_DATASET_ID,
  F_A0012_001_DATASET_ID,
  F_A0021_001_DATASET_ID,
  F_C0032_001_DATASET_ID,
  MARINE_FORECAST_CACHE_TTL_SECONDS,
  O_A0001_001_DATASET_ID,
  O_A0005_001_DATASET_ID,
  STATION_OBSERVATION_CACHE_TTL_SECONDS,
  TAIWAN_CITIES,
  UV_DAILY_MAX_CACHE_TTL_SECONDS,
  WEATHER_CACHE_TTL_SECONDS,
  EARTHQUAKE_CACHE_TTL_SECONDS,
  TIDE_FORECAST_CACHE_TTL_SECONDS,
  W_C0033_001_DATASET_ID,
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
// Structure below comes from real Go source code in a maintained third-party
// CWA client library (github.com/minchao/go-cwb, cwb/station_obs.go) — not a
// fresh direct capture from this session, and this exact evidence tier (real
// library, not a live capture) is what turned out stale for F-A0021-001 tide
// forecast earlier, so this is registered as an informed-but-unverified
// skeleton: `transform` filters to the requested station and passes
// `weatherElement` through as raw elementName/elementValue pairs rather than
// deep-extracting individual measurements (temperature, humidity, etc.),
// so a wrong assumption about which elementName values exist can't silently
// corrupt data or throw. Also unverified: whether the `locationName` filter
// is actually honored upstream — F-A0021-001 and aqx_p_432 both turned out
// not to honor an analogous filter, so this may need the same client-side
// re-filtering fix once fixtures-refresh.yml captures a real response.

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

interface CwaStationObsElement {
  elementName: string;
  elementValue: string;
}

interface CwaStationObsLocation {
  lat?: string;
  lon?: string;
  locationName: string;
  stationId?: string;
  time?: { obsTime?: string };
  weatherElement?: CwaStationObsElement[];
}

interface CwaStationObsRecords {
  location?: CwaStationObsLocation[];
}

export interface StationObservationResult {
  [key: string]: unknown;
  locationName: string;
  stationId?: string;
  obsTime?: string;
  /** Raw elementName/elementValue pairs, passed through as-is — see the module-level comment on why this isn't deep-extracted. */
  weatherElement: unknown[];
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
    const location = (raw.location ?? []).find(l => l.locationName === params.locationName);
    if (!location) {
      throw new ToolError({
        code: "NOT_FOUND",
        message: `中央氣象署沒有回傳「${params.locationName}」測站的觀測資料，請確認測站名稱是否正確（例如「合歡山」）。`
      });
    }
    return {
      locationName: location.locationName,
      stationId: location.stationId,
      obsTime: location.time?.obsTime,
      weatherElement: location.weatherElement ?? []
    };
  },
  cacheTtlSeconds: STATION_OBSERVATION_CACHE_TTL_SECONDS,
  updateFrequency: "每小時（確切頻率未經驗證）",
  docUrl: "https://opendata.cwa.gov.tw/dataset/observation/O-A0001-001",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。欄位結構依據第三方開源 CWA client 函式庫" +
    "（go-cwb）原始碼重建，本 session 未直接呼叫官方 API 驗證，待 fixtures-refresh.yml 下次排程時" +
    "以真實 API 回應確認欄位細節與 locationName 篩選是否於上游生效。",
  sampleParams: { locationName: "合歡山" },
  fixtureFileName: "station-observation.json"
};

// --- W-C0033-001: weather warnings (generic-layer only — minimal skeleton, structure unverified) ---
//
// Confirmed to exist and still maintained (opendata.cwa.gov.tw/dataset/
// warning/W-C0033-001, "天氣特報-各別縣市地區目前之天氣警特報情形"). This was
// skipped in an earlier session because no field-level structure could be
// found anywhere — official docs, third-party client libraries (go-cwb
// implements weather forecast/earthquake/tide/station observation, but not
// this dataset), or captured samples — despite extensive searching. Rather
// than guess field names (the exact failure mode that produced wrong
// PascalCase guesses for aqf_p_01/UV_S_01 and a stale structure for
// F-A0021-001 earlier in this project), this is registered as a
// deliberately minimal skeleton: no query params, `transform` passes the
// raw response through completely unparsed. fixtures-refresh.yml's next
// real dispatch will capture the actual shape, at which point this entry
// should be revisited with a proper transform.

export const weatherWarningInputShape = {};

export type WeatherWarningParams = Record<string, never>;

export interface WeatherWarningResult {
  [key: string]: unknown;
  raw: unknown;
}

export const weatherWarningEntry: DatasetEntry<WeatherWarningParams, unknown, WeatherWarningResult> = {
  id: "cwa:W-C0033-001",
  source: "cwa",
  path: W_C0033_001_DATASET_ID,
  title: "天氣特報",
  keywords: ["天氣特報", "特報", "警特報", "豪雨特報", "強風特報", "低溫特報", "陸上颱風警報", "weather warning", "weather alert"],
  paramsSchema: weatherWarningInputShape,
  buildQueryParams: () => ({}),
  transform: raw => ({ raw }),
  cacheTtlSeconds: WEATHER_WARNING_CACHE_TTL_SECONDS,
  updateFrequency: "特報發布/解除時即時更新（確切頻率未經驗證）",
  docUrl: "https://opendata.cwa.gov.tw/dataset/warning/W-C0033-001",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。結構完全未驗證——" +
    "transform 目前原樣透傳整個 records 內容（{ raw: ... }），待 fixtures-refresh.yml 首次真實抓取" +
    "後，再依實際回應設計正式的欄位擷取邏輯。使用者若透過 tw_query_dataset 查詢此資料集，會收到未經" +
    "整理的原始結構，而非其他資料集那樣的精簡欄位。",
  sampleParams: {},
  fixtureFileName: "weather-warning.json"
};

// --- F-A0012-001: marine weather forecast, offshore/coastal fishery (generic-layer only — minimal skeleton, structure unverified) ---
//
// Confirmed to exist and still maintained (opendata.cwa.gov.tw/dataset/
// forecast/F-A0012-001; official product doc title "海象_遠海漁業／近海漁業
// 氣象預報" — opendata.cwa.gov.tw/opendatadoc/Forecast/F-A0012.pdf). Primary
// format is a text bulletin (XML also available per the product doc), and
// no field-level JSON structure could be found — go-cwb doesn't implement
// this dataset either. Registered as a deliberately minimal skeleton, same
// rationale and same pass-through transform as W-C0033-001 above.

export const marineForecastInputShape = {};

export type MarineForecastParams = Record<string, never>;

export interface MarineForecastResult {
  [key: string]: unknown;
  raw: unknown;
}

export const marineForecastEntry: DatasetEntry<MarineForecastParams, unknown, MarineForecastResult> = {
  id: "cwa:F-A0012-001",
  source: "cwa",
  path: F_A0012_001_DATASET_ID,
  title: "海象_遠海漁業／近海漁業氣象預報",
  keywords: ["海象", "波浪", "海面天氣", "漁業氣象", "近海", "遠海", "浪高", "marine forecast", "wave forecast", "sea state"],
  paramsSchema: marineForecastInputShape,
  buildQueryParams: () => ({}),
  transform: raw => ({ raw }),
  cacheTtlSeconds: MARINE_FORECAST_CACHE_TTL_SECONDS,
  updateFrequency: "每日數次發布（確切頻率未經驗證）",
  docUrl: "https://opendata.cwa.gov.tw/dataset/forecast/F-A0012-001",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。結構完全未驗證——原始格式主要是文字檔（也提供 " +
    "XML），transform 目前原樣透傳整個 records 內容（{ raw: ... }），待 fixtures-refresh.yml 首次真實" +
    "抓取後，再依實際回應設計正式的欄位擷取邏輯。",
  sampleParams: {},
  fixtureFileName: "marine-forecast.json"
};

// --- O-A0005-001: daily maximum UV index (generic-layer only — minimal skeleton, structure unverified) ---
//
// Confirmed to exist (title "紫外線指數-每日紫外線指數最大值" per search-engine
// snippets referencing opendata.cwa.gov.tw/dataset/observation/O-A0005-001).
// This was skipped in an earlier session for the same reason as W-C0033-001
// above — no query-parameter name or field structure could be confirmed
// anywhere, only a secondhand GitHub issue mentioning that `locationCode`
// and `value` exist *somewhere* in the response, not enough to safely build
// buildQueryParams or transform. Worth flagging explicitly: CWA's own
// catalog puts this dataset under **"observation"** (`/dataset/observation/
// O-A0005-001`), not "forecast" — despite "daily maximum" sounding like a
// forecast product, this is presumably a same-day/end-of-day rollup of
// observed UV readings, not a forward-looking forecast. This entry is
// registered under CWA generically (keywords say "每日最大值", not
// "forecast") rather than being force-fit into forecast-style field naming,
// per the semantic mismatch already flagged before this dataset was first
// considered. If fixtures-refresh.yml's real dispatch confirms this really
// is observation-shaped data (e.g. a rolling window of past daily maxima
// rather than a single current value), that confirms the categorization and
// no forecast-style redesign is needed — just fill in the real transform.

export const uvDailyMaxInputShape = {};

export type UvDailyMaxParams = Record<string, never>;

export interface UvDailyMaxResult {
  [key: string]: unknown;
  raw: unknown;
}

export const uvDailyMaxEntry: DatasetEntry<UvDailyMaxParams, unknown, UvDailyMaxResult> = {
  id: "cwa:O-A0005-001",
  source: "cwa",
  path: O_A0005_001_DATASET_ID,
  title: "紫外線指數每日最大值",
  keywords: ["紫外線", "紫外線指數", "UV", "UVI", "每日最大值", "daily max uv", "uv index"],
  paramsSchema: uvDailyMaxInputShape,
  buildQueryParams: () => ({}),
  transform: raw => ({ raw }),
  cacheTtlSeconds: UV_DAILY_MAX_CACHE_TTL_SECONDS,
  updateFrequency: "每日更新（確切頻率未經驗證；官方分類為「觀測」而非「預報」，見上方模組註解）",
  docUrl: "https://opendata.cwa.gov.tw/dataset/observation/O-A0005-001",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。結構完全未驗證，transform 目前原樣透傳整個 " +
    "records 內容（{ raw: ... }），待 fixtures-refresh.yml 首次真實抓取後，再依實際回應設計正式的欄位" +
    "擷取邏輯。此資料集官方分類為「觀測」而非「預報」，命名與欄位設計應遵循觀測類語意，不強行套用" +
    "預報類欄位命名。",
  sampleParams: {},
  fixtureFileName: "uv-daily-max.json"
};

registerEntry(weatherForecastEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(recentEarthquakesEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(tideForecastEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(stationObservationEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(weatherWarningEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(marineForecastEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(uvDailyMaxEntry as unknown as DatasetEntry<never, unknown, unknown>);
