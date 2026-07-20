import { cwaAdapter } from "../adapters/cwa.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { toToolError } from "../infra/errors.js";
import { recentEarthquakesEntry, recentEarthquakesInputShape, type RecentEarthquakesResult } from "../registry/cwa.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

export { recentEarthquakesInputShape };
export type { RecentEarthquakesResult };

/**
 * Fetch + transform, no cache. Preserved as its own function (rather than
 * inlined into the tool handler below) so it keeps the same signature it
 * had before the layered refactor and can be unit-tested directly against
 * a mocked `fetchImpl`, same as before.
 */
export async function runRecentEarthquakes(
  limit: number,
  apiKey: string | undefined,
  fetchImpl?: typeof fetch
): Promise<RecentEarthquakesResult> {
  const raw = await cwaAdapter.fetchDataset(recentEarthquakesEntry, { limit }, { CWA_API_KEY: apiKey }, fetchImpl);
  return recentEarthquakesEntry.transform(raw, { limit });
}

export function formatRecentEarthquakesText(result: RecentEarthquakesResult): string {
  if (result.earthquakes.length === 0) {
    return "目前查無近期顯著有感地震報告。";
  }
  const lines = ["# 台灣近期顯著有感地震報告", ""];
  for (const eq of result.earthquakes) {
    lines.push(`## No.${eq.earthquakeNo} — ${eq.originTime}`);
    lines.push(`- 震央位置：${eq.epicenter}`);
    lines.push(`- 規模：${eq.magnitudeType} ${eq.magnitude}`);
    lines.push(`- 深度：${eq.depthKm} 公里`);
    lines.push(`- 最大震度：${eq.maxIntensity}`);
    lines.push(`- 說明：${eq.reportContent}`);
    if (eq.detailUrl) {
      lines.push(`- 詳細報告：${eq.detailUrl}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Composes cache + envelope on top of `runRecentEarthquakes`, for the MCP tool registration in index.ts. */
export async function handleRecentEarthquakesTool(
  params: { limit: number },
  env: Env,
  fetchImpl?: typeof fetch
): Promise<McpToolResult> {
  try {
    const { value: data, cached } = await withCacheTracked(
      env.CACHE,
      `quakes:${params.limit}`,
      recentEarthquakesEntry.cacheTtlSeconds,
      () => runRecentEarthquakes(params.limit, env.CWA_API_KEY, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: "中央氣象署",
      dataset: recentEarthquakesEntry.path,
      cached,
      updateFrequency: recentEarthquakesEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatRecentEarthquakesText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
