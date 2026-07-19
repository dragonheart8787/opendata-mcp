import { z } from "zod";
import { F_C0032_001_DATASET_ID, TAIWAN_CITIES } from "../constants.js";
import { CwaApiError, fetchCwaRecords } from "../services/cwa-client.js";
import type { CwaForecastLocation, CwaForecastRecords } from "../types.js";

export const weatherForecastInputShape = {
  city: z
    .enum(TAIWAN_CITIES)
    .describe(
      "台灣縣市名稱（22 縣市之一），必須使用中央氣象署的標準全形字，例如「臺北市」「臺中市」「臺東縣」" +
        "（注意是「臺」，不是常見的「台」）。"
    )
};

const WeatherForecastInput = z.object(weatherForecastInputShape);
export type WeatherForecastInput = z.infer<typeof WeatherForecastInput>;

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

export async function runWeatherForecast(
  city: string,
  apiKey: string | undefined,
  fetchImpl?: typeof fetch
): Promise<WeatherForecastResult> {
  const records = await fetchCwaRecords<CwaForecastRecords>(
    F_C0032_001_DATASET_ID,
    apiKey,
    { locationName: city },
    fetchImpl
  );

  const location = records.location.find(l => l.locationName === city);
  if (!location) {
    throw new CwaApiError(
      `中央氣象署沒有回傳「${city}」的預報資料。請確認縣市名稱是否正確（需使用「臺」而非「台」，例如「臺北市」）。`
    );
  }

  return { city, periods: extractPeriods(location) };
}

export function formatWeatherForecastText(result: WeatherForecastResult): string {
  if (result.periods.length === 0) {
    return `目前查無「${result.city}」的天氣預報資料。`;
  }
  const lines = [`# ${result.city} 36 小時天氣預報`, ""];
  for (const period of result.periods) {
    lines.push(`## ${period.startTime} ~ ${period.endTime}`);
    lines.push(`- 天氣狀況：${period.weather}`);
    lines.push(`- 降雨機率：${period.rainProbabilityPercent ?? "無資料"}%`);
    lines.push(`- 氣溫：${period.minTemperatureC ?? "?"}°C ~ ${period.maxTemperatureC ?? "?"}°C`);
    lines.push(`- 舒適度：${period.comfortIndex ?? "無資料"}`);
    lines.push("");
  }
  return lines.join("\n");
}
