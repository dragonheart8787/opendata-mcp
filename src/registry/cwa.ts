import { z } from "zod";
import {
  E_A0015_001_DATASET_ID,
  F_A0021_001_DATASET_ID,
  F_C0032_001_DATASET_ID,
  TAIWAN_CITIES,
  WEATHER_CACHE_TTL_SECONDS,
  EARTHQUAKE_CACHE_TTL_SECONDS,
  TIDE_FORECAST_CACHE_TTL_SECONDS
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
// 滿潮乾潮、時間、潮高)"). This sandbox cannot reach opendata.cwa.gov.tw
// directly (blocked, same as every prior session), so the shape below is
// reconstructed from a real captured API response committed as a test
// fixture in a maintained third-party CWA client library
// (github.com/minchao/go-cwb, cwb/testdata/F-A0021-001.json) — not a fresh
// direct capture from this session. The `locationName` query param is
// confirmed the same way (used verbatim in that library's request-building
// code and tests). `transform` is deliberately shallow — it filters to the
// requested location and passes the `time` array through close to as-is,
// rather than deep-extracting individual parameter fields whose exact
// nesting isn't independently confirmed — so a wrong assumption about deep
// structure can't silently corrupt data or throw. Needs a real capture via
// fixtures-refresh.yml before this confidence level is fully resolved.

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

interface CwaTideLocation {
  locationName: string;
  stationId?: string;
  time?: unknown[];
}

interface CwaTideRecords {
  datasetDescription?: string;
  location?: CwaTideLocation[];
}

export interface TideForecastResult {
  [key: string]: unknown;
  locationName: string;
  stationId?: string;
  /** Raw per-day tide entries, passed through close to as-is — see the module-level comment on why this isn't deep-extracted. */
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
    const location = (raw.location ?? []).find(l => l.locationName === params.locationName);
    if (!location) {
      throw new ToolError({
        code: "NOT_FOUND",
        message:
          `中央氣象署沒有回傳「${params.locationName}」的潮汐預報資料，請確認地點名稱是否為中央氣象署潮汐預報` +
          `清單中的正確全名（通常是鄉鎮層級，例如「宜蘭縣南澳鄉」）。`
      });
    }
    return {
      locationName: location.locationName,
      stationId: location.stationId,
      forecast: location.time ?? []
    };
  },
  cacheTtlSeconds: TIDE_FORECAST_CACHE_TTL_SECONDS,
  updateFrequency: "每月更新（提供未來 1 個月預報）",
  docUrl: "https://opendata.cwa.gov.tw/dataset/observation/F-A0021-001",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。回應結構依據第三方開源 CWA client 函式庫" +
    "（go-cwb）提交的真實 API 回應樣本重建，本 session 未直接呼叫官方 API 驗證，待 fixtures-refresh.yml" +
    "下次排程時以真實 API 回應確認欄位細節（尤其 forecast 陣列內的巢狀結構）。",
  sampleParams: { locationName: "宜蘭縣南澳鄉" },
  fixtureFileName: "tide-forecast.json"
};

registerEntry(weatherForecastEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(recentEarthquakesEntry as unknown as DatasetEntry<never, unknown, unknown>);
registerEntry(tideForecastEntry as unknown as DatasetEntry<never, unknown, unknown>);
