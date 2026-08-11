import { openMeteoAdapter } from "../adapters/open-meteo.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { toToolError } from "../infra/errors.js";
import {
  globalWeatherInputShape,
  openMeteoForecastEntry,
  type GlobalWeatherDailyResult,
  type GlobalWeatherParams,
  type GlobalWeatherResult
} from "../registry/open-meteo.js";
import { getSourceLicence, getSourceProvenance } from "../registry/index.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

export { globalWeatherInputShape };

/** Fetch + transform, no join needed — single-entry tool, same pattern as tw_highway_traffic/tw_typhoon. */
export async function runGlobalWeather(
  params: GlobalWeatherParams,
  env: Env,
  fetchImpl?: typeof fetch
): Promise<GlobalWeatherResult> {
  const raw = await openMeteoAdapter.fetchDataset(openMeteoForecastEntry, params, env, fetchImpl);
  return openMeteoForecastEntry.transform(raw, params);
}

function formatCoordinate(value: number | null): string {
  return value === null ? "未知" : String(value);
}

function formatDailyLine(day: GlobalWeatherDailyResult): string {
  const condition = day.weather.descriptionZh ?? (day.weather.code === null ? "無資料" : `WMO 代碼 ${day.weather.code}`);
  const temps =
    day.temperatureMinC !== null && day.temperatureMaxC !== null
      ? `${day.temperatureMinC}–${day.temperatureMaxC}°C`
      : "氣溫無資料";
  const rain = day.precipitationProbabilityMaxPercent !== null ? `，降雨機率最高 ${day.precipitationProbabilityMaxPercent}%` : "";
  const amount = day.precipitationSumMm !== null ? `，累積雨量 ${day.precipitationSumMm} mm` : "";
  return `- ${day.date ?? "日期未知"}：${condition}，${temps}${rain}${amount}`;
}

export function formatGlobalWeatherText(result: GlobalWeatherResult): string {
  const lines = [
    `# 全球天氣查詢（${formatCoordinate(result.resolved.latitude)}, ${formatCoordinate(result.resolved.longitude)}）`,
    ""
  ];

  // Surfaced first because everything below is *for this grid point*, not
  // for the caller's exact coordinate — see registry/open-meteo.ts (2).
  lines.push(
    `查詢座標：${result.requested.latitude}, ${result.requested.longitude}　→　` +
      `實際取用的模式網格點：${formatCoordinate(result.resolved.latitude)}, ${formatCoordinate(result.resolved.longitude)}` +
      (result.resolved.elevationM !== null ? `（海拔 ${result.resolved.elevationM} 公尺）` : "")
  );
  lines.push(`時區：${result.timezone ?? "未知"}${result.timezoneAbbreviation ? `（${result.timezoneAbbreviation}）` : ""}，以下所有時間均為當地時間。`);
  lines.push("");

  const current = result.current;
  if (current === null) {
    lines.push("## 目前天氣");
    lines.push("上游未回傳目前天氣資料。");
  } else {
    lines.push(`## 目前天氣（當地時間 ${current.time ?? "未知"}）`);
    const condition = current.weather.descriptionZh ?? (current.weather.code === null ? "無資料" : `WMO 代碼 ${current.weather.code}`);
    lines.push(`- 天氣狀況：${condition}${current.weather.description ? `（原文：${current.weather.description}）` : ""}`);
    if (current.temperatureC !== null) {
      lines.push(`- 氣溫：${current.temperatureC}°C${current.apparentTemperatureC !== null ? `（體感 ${current.apparentTemperatureC}°C）` : ""}`);
    }
    if (current.relativeHumidityPercent !== null) {
      lines.push(`- 相對濕度：${current.relativeHumidityPercent}%`);
    }
    if (current.precipitationMm !== null) {
      lines.push(`- 降水量：${current.precipitationMm} mm`);
    }
    if (current.windSpeedKmh !== null) {
      lines.push(
        `- 風速：${current.windSpeedKmh} km/h` +
          (current.windDirectionDegrees !== null ? `，風向 ${current.windDirectionDegrees}°` : "") +
          (current.windGustsKmh !== null ? `，陣風 ${current.windGustsKmh} km/h` : "")
      );
    }
    if (current.cloudCoverPercent !== null) {
      lines.push(`- 雲量：${current.cloudCoverPercent}%`);
    }
  }

  lines.push("");
  lines.push(`## 每日預報（${result.daily.length} 天）`);
  if (result.daily.length === 0) {
    lines.push("上游未回傳每日預報資料。");
  } else {
    for (const day of result.daily) {
      lines.push(formatDailyLine(day));
    }
  }

  if (result.weatherCodeNote !== undefined) {
    lines.push("");
    lines.push(result.weatherCodeNote);
  }

  lines.push("");
  lines.push(result.attribution);
  return lines.join("\n").trimEnd() + "\n";
}

/** Composes cache + envelope on top of `runGlobalWeather`, for the MCP tool registration in index.ts. */
export async function handleGlobalWeatherTool(
  params: GlobalWeatherParams,
  env: Env,
  fetchImpl?: typeof fetch
): Promise<McpToolResult> {
  try {
    const cacheKey = `openmeteo-forecast:${params.latitude},${params.longitude},${params.forecastDays ?? "default"}`;
    const { value: data, cached } = await withCacheTracked(env.CACHE, cacheKey, openMeteoForecastEntry.cacheTtlSeconds, () =>
      runGlobalWeather(params, env, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: openMeteoAdapter.displayName,
      // Both derived from the entry's own source rather than hard-coded, so
      // this tool can't drift from what tw_query_dataset reports for the
      // same dataset. Resolves to "third-party-aggregator" + CC BY 4.0 here,
      // which is exactly when the envelope emits both keys.
      provenance: getSourceProvenance(openMeteoForecastEntry.source),
      licence: getSourceLicence(openMeteoForecastEntry.source),
      dataset: openMeteoForecastEntry.id,
      cached,
      updateFrequency: openMeteoForecastEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatGlobalWeatherText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
