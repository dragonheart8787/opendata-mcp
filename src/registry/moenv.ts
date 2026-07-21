import { z } from "zod";
import {
  AQX_P_432_DATASET_ID,
  AQX_P_432_FETCH_LIMIT,
  TAIWAN_CITIES,
  AIR_QUALITY_CACHE_TTL_SECONDS,
  AQF_P_01_DATASET_ID,
  AIR_QUALITY_FORECAST_CACHE_TTL_SECONDS,
  UV_S_01_DATASET_ID,
  UV_REALTIME_CACHE_TTL_SECONDS
} from "../constants.js";
import { ToolError } from "../infra/errors.js";
import type { MoenvAqiRecordNormalized } from "../types.js";
import { registerEntry, type DatasetEntry } from "./index.js";

export const airQualityInputShape = {
  county: z
    .enum(TAIWAN_CITIES)
    .optional()
    .describe(
      "縣市名稱（台灣 22 縣市之一），回傳該縣市所有測站的空氣品質。" +
        "須用「臺」而非「台」（例如「臺北市」）。county 與 siteName 擇一必填。"
    ),
  siteName: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "空氣品質測站名稱（例如「板橋」「西屯」「美濃」），只回傳該單一測站的資料。" +
        "county 與 siteName 擇一必填。"
    )
};

export interface AirQualityParams {
  county?: string;
  siteName?: string;
}

export interface AirQualityStation {
  siteName: string;
  county: string;
  aqi: number | null;
  status: string;
  mainPollutant: string | null;
  pm25: number | null;
  pm10: number | null;
  o3: number | null;
  publishTime: string;
}

export interface AirQualityResult {
  [key: string]: unknown;
  query: { county?: string; siteName?: string };
  stations: AirQualityStation[];
}

/**
 * "Exactly one of county/siteName" — a relationship between two
 * independently-optional fields that `airQualityInputShape` alone can't
 * express (each field is valid on its own). Shared by `runAirQuality`
 * (src/tools/air-quality.ts) and `tw_query_dataset` (tools/generic.ts, via
 * `DatasetEntry.validateParams`) so the rule can't drift between the two
 * call paths.
 */
export function validateAirQualityParams(params: AirQualityParams): void {
  if (!params.county && !params.siteName) {
    throw new ToolError({
      code: "INVALID_PARAMS",
      message: "請提供 county（縣市）或 siteName（測站名稱）其中一個參數，例如 county=\"臺北市\" 或 siteName=\"板橋\"。"
    });
  }
  if (params.county && params.siteName) {
    throw new ToolError({
      code: "INVALID_PARAMS",
      message: "county 與 siteName 只能擇一提供：查整個縣市請只給 county，查單一測站請只給 siteName。"
    });
  }
}

function toNumberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function summarizeStation(record: MoenvAqiRecordNormalized): AirQualityStation {
  return {
    siteName: record.sitename ?? "",
    county: record.county ?? "",
    aqi: toNumberOrNull(record.aqi),
    status: record.status ?? "無資料",
    mainPollutant: record.pollutant,
    pm25: toNumberOrNull(record["pm2.5"]),
    pm10: toNumberOrNull(record.pm10),
    o3: toNumberOrNull(record.o3),
    publishTime: record.publishtime ?? ""
  };
}

export const airQualityEntry: DatasetEntry<AirQualityParams, MoenvAqiRecordNormalized[], AirQualityResult> = {
  id: "moenv:aqx_p_432",
  source: "moenv",
  path: AQX_P_432_DATASET_ID,
  title: "空氣品質指標（AQI）",
  keywords: ["空氣品質", "空品", "AQI", "PM2.5", "PM10", "臭氧", "air quality"],
  paramsSchema: airQualityInputShape,
  validateParams: validateAirQualityParams,
  buildQueryParams: params => ({
    filters: params.county ? `county,EQ,${params.county}` : `sitename,EQ,${params.siteName}`,
    limit: String(AQX_P_432_FETCH_LIMIT)
  }),
  transform: (raw, params) => {
    const { county, siteName } = params;

    // Defensive check: if we got back exactly `limit` records, the upstream
    // may have truncated the nationwide list rather than returning
    // everything (e.g. the station network grew past our fetch limit).
    // Client-side filtering below would then silently miss stations
    // instead of failing loudly, so flag it — this should never fire in
    // practice (~83-90 stations vs. a limit of 1000) but costs nothing to
    // check.
    if (raw.length >= AQX_P_432_FETCH_LIMIT) {
      console.warn(
        `[air-quality] fetched ${raw.length} records, which meets or exceeds the ` +
          `configured limit (${AQX_P_432_FETCH_LIMIT}) — the nationwide station list may have been ` +
          `truncated, and client-side filtering below could miss matching stations.`
      );
    }

    // Defense in depth: the `filters` query param sent to MOENV is not
    // reliably honored for this dataset — production traffic showed a
    // `filters=sitename,EQ,...` request come back with the full,
    // unfiltered nationwide station list. Always re-filter client-side so
    // the returned stations are correct regardless of whether upstream
    // actually applied it.
    const matched = county ? raw.filter(r => r.county === county) : raw.filter(r => r.sitename === siteName);

    if (matched.length === 0) {
      if (siteName) {
        throw new ToolError({
          code: "NOT_FOUND",
          message:
            `找不到名為「${siteName}」的空氣品質測站。請確認測站名稱（例如「板橋」「西屯」「美濃」，不含「站」字），` +
            `或改用 county 參數查詢整個縣市。`
        });
      }
      throw new ToolError({
        code: "NOT_FOUND",
        message: `環境部平臺沒有回傳「${county}」的測站資料。請確認縣市名稱使用「臺」而非「台」（例如「臺北市」）。`
      });
    }

    return {
      query: county ? { county } : { siteName },
      stations: matched.map(summarizeStation)
    };
  },
  cacheTtlSeconds: AIR_QUALITY_CACHE_TTL_SECONDS,
  updateFrequency: "每小時",
  docUrl: "https://data.moenv.gov.tw/dataset/detail/aqx_p_432",
  notes: "僅提供當前小時的即時觀測值，不涵蓋歷史紀錄也不涵蓋預報值。"
};

registerEntry(airQualityEntry as unknown as DatasetEntry<never, unknown, unknown>);

// --- aqf_p_01: air quality forecast (generic-layer only — distinct from aqx_p_432's real-time AQI) ---
//
// Confirmed to exist and still maintained (data.moenv.gov.tw/dataset/detail/
// aqf_p_01, "空氣品質預報資料", published 3x/day per the dataset's own
// description). This sandbox cannot reach data.moenv.gov.tw directly
// (blocked, same as every prior session), so field names below come from
// the dataset's own description page content (Content/PublishTime/Area/
// MajorPollutant/ForecastDate/AQI/MinorPollutant/MinorPollutantAQI) rather
// than a fresh direct capture. Filters client-side (matching aqx_p_432's
// established defense against MOENV not reliably honoring the `filters`
// query param) so a wrong assumption about the upstream filter behavior
// degrades to "returns everything" rather than silently missing matches.

interface AqiForecastRecord {
  Content: string | null;
  PublishTime: string | null;
  Area: string | null;
  MajorPollutant: string | null;
  ForecastDate: string | null;
  AQI: string | null;
  MinorPollutant: string | null;
  MinorPollutantAQI: string | null;
}

export const airQualityForecastInputShape = {
  area: z
    .string()
    .min(1)
    .optional()
    .describe(
      "空氣品質預報分區名稱（例如「北部」「中部」「雲嘉南」「高屏」「宜蘭」「花東」等），" +
        "不填則回傳所有分區。本伺服器未內建完整分區清單。"
    )
};

export interface AirQualityForecastParams {
  area?: string;
}

export interface AirQualityForecastResult {
  [key: string]: unknown;
  query: { area?: string };
  forecasts: Array<{
    area: string | null;
    forecastDate: string | null;
    aqi: string | null;
    majorPollutant: string | null;
    minorPollutant: string | null;
    minorPollutantAqi: string | null;
    publishTime: string | null;
    content: string | null;
  }>;
}

export const airQualityForecastEntry: DatasetEntry<AirQualityForecastParams, AqiForecastRecord[], AirQualityForecastResult> = {
  id: "moenv:aqf_p_01",
  source: "moenv",
  path: AQF_P_01_DATASET_ID,
  title: "空氣品質預報",
  keywords: ["空氣品質預報", "空品預報", "AQI 預報", "明日空氣品質", "air quality forecast", "aqi forecast"],
  paramsSchema: airQualityForecastInputShape,
  buildQueryParams: params => ({
    filters: params.area ? `Area,EQ,${params.area}` : undefined,
    limit: "1000"
  }),
  transform: (raw, params) => {
    const matched = params.area ? raw.filter(r => r.Area === params.area) : raw;
    return {
      query: params.area ? { area: params.area } : {},
      forecasts: matched.map(r => ({
        area: r.Area,
        forecastDate: r.ForecastDate,
        aqi: r.AQI,
        majorPollutant: r.MajorPollutant,
        minorPollutant: r.MinorPollutant,
        minorPollutantAqi: r.MinorPollutantAQI,
        publishTime: r.PublishTime,
        content: r.Content
      }))
    };
  },
  cacheTtlSeconds: AIR_QUALITY_FORECAST_CACHE_TTL_SECONDS,
  updateFrequency: "每日 3 次發布（10:30、16:30、22:00），視情況每 30 分鐘更新",
  docUrl: "https://data.moenv.gov.tw/dataset/detail/aqf_p_01",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。與即時 aqx_p_432 是不同資料集——這是「預報」，" +
    "不是即時觀測值。欄位名稱與大小寫依資料集說明頁確認，本 session 未直接呼叫官方 API 驗證，" +
    "待 fixtures-refresh.yml 下次排程時以真實 API 回應確認。"
};

registerEntry(airQualityForecastEntry as unknown as DatasetEntry<never, unknown, unknown>);

// --- UV_S_01: real-time UV index by station (generic-layer only) ---
//
// Confirmed to exist and still maintained (data.moenv.gov.tw/dataset/detail/
// UV_S_01, "紫外線即時監測資料", hourly). Field names below
// (SiteName/Uvi/Unit/County/WGS84_LON/WGS84_LAT/DataCreationDate) come from
// the current data.moenv.gov.tw dataset page content — NOT from the older
// epa.gov.tw mirror of the same dataset, which uses different field names
// (UVI/WGS84Lat/WGS84Lon) and is exactly the kind of stale-domain field-
// casing drift docs/ARCHITECTURE.md already flags as a known MOENV risk.
// `Unit` field's exact meaning (measurement unit vs. a danger-level code)
// isn't confirmed, so it's passed through as an opaque string rather than
// interpreted.

interface UvRealtimeRecord {
  SiteName: string | null;
  Uvi: string | null;
  Unit: string | null;
  County: string | null;
  WGS84_LON: string | null;
  WGS84_LAT: string | null;
  DataCreationDate: string | null;
}

export const uvRealtimeInputShape = {
  county: z
    .enum(TAIWAN_CITIES)
    .optional()
    .describe(
      "縣市名稱（台灣 22 縣市之一），回傳該縣市所有測站的紫外線指數。不填則回傳所有測站。須用「臺」而非「台」。"
    )
};

export interface UvRealtimeParams {
  county?: string;
}

export interface UvRealtimeStation {
  siteName: string | null;
  uvi: number | null;
  county: string | null;
  dataTime: string | null;
}

export interface UvRealtimeResult {
  [key: string]: unknown;
  query: { county?: string };
  stations: UvRealtimeStation[];
}

function toNumberOrNullUv(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

export const uvRealtimeEntry: DatasetEntry<UvRealtimeParams, UvRealtimeRecord[], UvRealtimeResult> = {
  id: "moenv:UV_S_01",
  source: "moenv",
  path: UV_S_01_DATASET_ID,
  title: "紫外線即時監測資料",
  keywords: ["紫外線", "紫外線指數", "UV", "UVI", "曬傷", "防曬", "uv index", "real-time uv", "紫外線測站"],
  paramsSchema: uvRealtimeInputShape,
  buildQueryParams: params => ({
    filters: params.county ? `County,EQ,${params.county}` : undefined,
    limit: "1000"
  }),
  transform: (raw, params) => {
    const matched = params.county ? raw.filter(r => r.County === params.county) : raw;
    return {
      query: params.county ? { county: params.county } : {},
      stations: matched.map(r => ({
        siteName: r.SiteName,
        uvi: toNumberOrNullUv(r.Uvi),
        county: r.County,
        dataTime: r.DataCreationDate
      }))
    };
  },
  cacheTtlSeconds: UV_REALTIME_CACHE_TTL_SECONDS,
  updateFrequency: "每小時更新",
  docUrl: "https://data.moenv.gov.tw/dataset/detail/UV_S_01",
  notes:
    "透過通用層（tw_query_dataset）查詢，尚無專屬工具。與 CWA 的每日紫外線指數（每日最大值）角度不同——" +
    "這是環境部測站的即時觀測值，非每日最大值。本 session 未直接呼叫官方 API 驗證，" +
    "待 fixtures-refresh.yml 下次排程時以真實 API 回應確認。"
};

registerEntry(uvRealtimeEntry as unknown as DatasetEntry<never, unknown, unknown>);
