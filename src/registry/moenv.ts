import { z } from "zod";
import { AQX_P_432_DATASET_ID, AQX_P_432_FETCH_LIMIT, TAIWAN_CITIES, AIR_QUALITY_CACHE_TTL_SECONDS } from "../constants.js";
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
