import { z } from "zod";
import { AQX_P_432_DATASET_ID, TAIWAN_CITIES } from "../constants.js";
import { OpenDataApiError } from "../services/errors.js";
import { fetchMoenvRecords } from "../services/moenv-client.js";
import type { MoenvAqiRecord } from "../types.js";

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

const AirQualityInput = z.object(airQualityInputShape);
export type AirQualityInput = z.infer<typeof AirQualityInput>;

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

/** MOENV uses "", "-" and "ND" for unavailable measurements; Number("") is 0, so guard first. */
function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined || value === "" || value === "-" || value === "ND") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function summarizeStation(record: MoenvAqiRecord): AirQualityStation {
  return {
    siteName: record.sitename,
    county: record.county,
    aqi: toNumberOrNull(record.aqi),
    status: record.status || "無資料",
    mainPollutant: record.pollutant || null,
    pm25: toNumberOrNull(record["pm2.5"]),
    pm10: toNumberOrNull(record.pm10),
    o3: toNumberOrNull(record.o3),
    publishTime: record.publishtime
  };
}

export async function runAirQuality(
  input: { county?: string; siteName?: string },
  apiKey: string | undefined,
  fetchImpl?: typeof fetch
): Promise<AirQualityResult> {
  const { county, siteName } = input;
  if (!county && !siteName) {
    throw new OpenDataApiError(
      "請提供 county（縣市）或 siteName（測站名稱）其中一個參數，例如 county=\"臺北市\" 或 siteName=\"板橋\"。"
    );
  }
  if (county && siteName) {
    throw new OpenDataApiError(
      "county 與 siteName 只能擇一提供：查整個縣市請只給 county，查單一測站請只給 siteName。"
    );
  }

  const filter = county ? `county,EQ,${county}` : `sitename,EQ,${siteName}`;
  const records = await fetchMoenvRecords<MoenvAqiRecord>(
    AQX_P_432_DATASET_ID,
    apiKey,
    { filters: filter, limit: "1000" },
    fetchImpl
  );

  // Defense in depth: the `filters` query param above is not reliably
  // honored by MOENV for this dataset — production traffic showed a
  // `filters=sitename,EQ,...` request come back with the full, unfiltered
  // nationwide station list. Always re-filter client-side so the returned
  // stations are correct regardless of whether upstream actually applied it.
  const matched = county ? records.filter(r => r.county === county) : records.filter(r => r.sitename === siteName);

  if (matched.length === 0) {
    if (siteName) {
      throw new OpenDataApiError(
        `找不到名為「${siteName}」的空氣品質測站。請確認測站名稱（例如「板橋」「西屯」「美濃」，不含「站」字），` +
          `或改用 county 參數查詢整個縣市。`
      );
    }
    throw new OpenDataApiError(
      `環境部平臺沒有回傳「${county}」的測站資料。請確認縣市名稱使用「臺」而非「台」（例如「臺北市」）。`
    );
  }

  return {
    query: county ? { county } : { siteName },
    stations: matched.map(summarizeStation)
  };
}

export function formatAirQualityText(result: AirQualityResult): string {
  const scope = result.query.county ?? result.query.siteName ?? "";
  const lines = [`# ${scope} 空氣品質（AQI）`, ""];
  for (const station of result.stations) {
    lines.push(`## ${station.siteName}（${station.county}）`);
    lines.push(`- AQI：${station.aqi ?? "無資料"}（${station.status}）`);
    if (station.mainPollutant) {
      lines.push(`- 主要污染物：${station.mainPollutant}`);
    }
    lines.push(`- PM2.5：${station.pm25 ?? "無資料"} μg/m³`);
    lines.push(`- PM10：${station.pm10 ?? "無資料"} μg/m³`);
    lines.push(`- O3：${station.o3 ?? "無資料"} ppb`);
    lines.push(`- 發布時間：${station.publishTime}`);
    lines.push("");
  }
  return lines.join("\n");
}
