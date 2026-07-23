import { highwayAdapter } from "../adapters/highway.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { toToolError } from "../infra/errors.js";
import {
  highwayLiveEventsEntry,
  highwayLiveEventsInputShape,
  type HighwayLiveEventResult,
  type HighwayLiveEventsParams
} from "../registry/highway.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

export { highwayLiveEventsInputShape };

/** Fetch + transform, no join needed — single-entry tool, same pattern as tw_metro_status/tw_typhoon. */
export async function runHighwayTraffic(
  params: HighwayLiveEventsParams,
  env: Env,
  fetchImpl?: typeof fetch
) {
  const raw = await highwayAdapter.fetchDataset(highwayLiveEventsEntry, params, env, fetchImpl);
  return highwayLiveEventsEntry.transform(raw, params);
}

function formatEventLine(event: HighwayLiveEventResult): string {
  const location = [event.road, event.direction, event.startKm].filter(v => v !== null).join(" ");
  const title = event.title ?? "（無標題）";
  const description = event.description && event.description !== event.title ? `：${event.description}` : "";
  const impact = event.impactDescription ? `\n  影響：${event.impactDescription}` : "";
  return `- [${location || "位置未知"}] ${title}${description}${impact}`;
}

export function formatHighwayTrafficText(result: Awaited<ReturnType<typeof runHighwayTraffic>>): string {
  const heading = result.query.road ? `# 國道即時交通事件（篩選：${result.query.road}）` : "# 國道即時交通事件（全國）";
  const lines = [heading, ""];

  if (result.events.length === 0) {
    lines.push(
      "目前查無符合的國道即時事件。這代表目前沒有官方回報的事故/施工/管制事件（或篩選條件下沒有符合的道路），" +
        "不代表本伺服器查詢失敗。"
    );
  } else {
    lines.push("以下逐字轉載交通部高速公路局『交通資料庫』目前公告的事件標題與內容，本伺服器不自行判斷嚴重程度：");
    lines.push("");
    for (const event of result.events) {
      lines.push(formatEventLine(event));
    }
  }

  lines.push("");
  lines.push(`資料更新時間：${result.updateTime ?? "無資料"}`);
  if (result.updateIntervalSeconds !== null) {
    lines.push(`⚠️ 官方回報此資料約每 ${result.updateIntervalSeconds} 秒批次更新一次（非本伺服器推測），查詢結果可能落後實際狀況數十秒。`);
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Composes cache + envelope on top of `runHighwayTraffic`, for the MCP tool registration in index.ts. */
export async function handleHighwayTrafficTool(
  params: HighwayLiveEventsParams,
  env: Env,
  fetchImpl?: typeof fetch
): Promise<McpToolResult> {
  try {
    const cacheKey = `highway-live-events:${params.road ?? ""}`;
    const { value: data, cached } = await withCacheTracked(env.CACHE, cacheKey, highwayLiveEventsEntry.cacheTtlSeconds, () =>
      runHighwayTraffic(params, env, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: "交通部高速公路局『交通資料庫』",
      dataset: highwayLiveEventsEntry.id,
      cached,
      updateFrequency: highwayLiveEventsEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatHighwayTrafficText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
