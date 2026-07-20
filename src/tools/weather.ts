import { cwaAdapter } from "../adapters/cwa.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { toToolError } from "../infra/errors.js";
import { weatherForecastEntry, weatherForecastInputShape, type WeatherForecastResult } from "../registry/cwa.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

export { weatherForecastInputShape };
export type { WeatherForecastResult };

/**
 * Fetch + transform, no cache. Preserved as its own function (rather than
 * inlined into the tool handler below) so it keeps the same signature it
 * had before the layered refactor and can be unit-tested directly against
 * a mocked `fetchImpl`, same as before.
 */
export async function runWeatherForecast(
  city: string,
  apiKey: string | undefined,
  fetchImpl?: typeof fetch
): Promise<WeatherForecastResult> {
  const raw = await cwaAdapter.fetchDataset(weatherForecastEntry, { city }, { CWA_API_KEY: apiKey }, fetchImpl);
  return weatherForecastEntry.transform(raw, { city });
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

/** Composes cache + envelope on top of `runWeatherForecast`, for the MCP tool registration in index.ts. */
export async function handleWeatherForecastTool(
  params: { city: string },
  env: Env,
  fetchImpl?: typeof fetch
): Promise<McpToolResult> {
  try {
    const { value: data, cached } = await withCacheTracked(
      env.CACHE,
      `weather:${params.city}`,
      weatherForecastEntry.cacheTtlSeconds,
      () => runWeatherForecast(params.city, env.CWA_API_KEY, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: "中央氣象署",
      dataset: weatherForecastEntry.path,
      cached,
      updateFrequency: weatherForecastEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatWeatherForecastText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
