import { moenvAdapter } from "../adapters/moenv.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { ToolError, toToolError } from "../infra/errors.js";
import { airQualityEntry, airQualityInputShape, type AirQualityResult } from "../registry/moenv.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

export { airQualityInputShape };
export type { AirQualityResult };

/**
 * Fetch + transform, no cache. Preserved as its own function (rather than
 * inlined into the tool handler below) so it keeps the same signature it
 * had before the layered refactor and can be unit-tested directly against
 * a mocked `fetchImpl`, same as before.
 */
export async function runAirQuality(
  input: { county?: string; siteName?: string },
  apiKey: string | undefined,
  fetchImpl?: typeof fetch
): Promise<AirQualityResult> {
  const { county, siteName } = input;
  if (!county && !siteName) {
    throw new ToolError({
      code: "INVALID_PARAMS",
      message: "請提供 county（縣市）或 siteName（測站名稱）其中一個參數，例如 county=\"臺北市\" 或 siteName=\"板橋\"。"
    });
  }
  if (county && siteName) {
    throw new ToolError({
      code: "INVALID_PARAMS",
      message: "county 與 siteName 只能擇一提供：查整個縣市請只給 county，查單一測站請只給 siteName。"
    });
  }

  const raw = await moenvAdapter.fetchDataset(airQualityEntry, input, { MOENV_API_KEY: apiKey }, fetchImpl);
  return airQualityEntry.transform(raw, input);
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

/** Composes cache + envelope on top of `runAirQuality`, for the MCP tool registration in index.ts. */
export async function handleAirQualityTool(
  params: { county?: string; siteName?: string },
  env: Env,
  fetchImpl?: typeof fetch
): Promise<McpToolResult> {
  try {
    const cacheKey = params.county ? `aqi:county:${params.county}` : `aqi:site:${params.siteName}`;
    const { value: data, cached } = await withCacheTracked(env.CACHE, cacheKey, airQualityEntry.cacheTtlSeconds, () =>
      runAirQuality(params, env.MOENV_API_KEY, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: "環境部",
      dataset: airQualityEntry.path,
      cached,
      updateFrequency: airQualityEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatAirQualityText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
