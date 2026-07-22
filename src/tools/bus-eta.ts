import { tdxAdapter } from "../adapters/tdx.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { toToolError } from "../infra/errors.js";
import { busEtaEntry, busEtaInputShape, type BusEtaParams, type BusEtaResult, type BusEtaStop } from "../registry/tdx.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

export { busEtaInputShape };
export type { BusEtaResult };

/** Fetch + transform, no cache. Directly unit-testable against a mocked `fetchImpl`, same pattern as the other curated tools. */
export async function runBusEta(params: BusEtaParams, env: Env, fetchImpl?: typeof fetch): Promise<BusEtaResult> {
  const raw = await tdxAdapter.fetchDataset(busEtaEntry, params, env, fetchImpl);
  return busEtaEntry.transform(raw, params);
}

function formatEstimate(stop: BusEtaStop): string {
  if (stop.estimateSeconds === null) {
    return "目前無預估到站時間";
  }
  if (stop.estimateSeconds <= 60) {
    return "即將到站";
  }
  const minutes = Math.round(stop.estimateSeconds / 60);
  return `約 ${minutes} 分鐘後到站`;
}

function directionLabel(direction: number | null): string {
  if (direction === null) return "";
  return direction === 0 ? "（去程）" : direction === 1 ? "（返程）" : `（方向代碼 ${direction}）`;
}

export function formatBusEtaText(result: BusEtaResult): string {
  if (result.stops.length === 0) {
    return (
      `目前查無符合條件的公車到站資料（城市：${result.query.city}` +
      `${result.query.routeName ? `，路線：${result.query.routeName}` : ""}` +
      `${result.query.stopName ? `，站牌：${result.query.stopName}` : ""}）。` +
      "可能是路線/站牌名稱有誤，或該路線今日未營運、目前沒有動態資料，不代表本伺服器資料異常。"
    );
  }

  const lines = [`# 公車動態預估到站時間（${result.query.city}）`, ""];
  for (const stop of result.stops) {
    const route = stop.routeName ?? "（未知路線）";
    const stopName = stop.stopName ?? "（未知站牌）";
    lines.push(`- ${route}${directionLabel(stop.direction)} → ${stopName}：${formatEstimate(stop)}（更新時間：${stop.updateTime ?? "無資料"}）`);
  }
  if (result.truncated) {
    lines.push("");
    lines.push(
      `⚠️ 符合條件的站牌共 ${result.totalMatched} 筆，本回應僅顯示前 ${result.stops.length} 筆。` +
        "請提供 routeName 或 stopName 縮小查詢範圍以取得完整結果。"
    );
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Composes cache + envelope on top of `runBusEta`, for the MCP tool registration in index.ts. */
export async function handleBusEtaTool(params: BusEtaParams, env: Env, fetchImpl?: typeof fetch): Promise<McpToolResult> {
  try {
    const cacheKey = `bus-eta:${params.city}:${params.routeName ?? ""}:${params.stopName ?? ""}`;
    const { value: data, cached } = await withCacheTracked(env.CACHE, cacheKey, busEtaEntry.cacheTtlSeconds, () =>
      runBusEta(params, env, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: "交通部運輸資料流通服務",
      // Deviation from the other tools' `dataset: entry.path` convention:
      // for CWA/MOENV, `path` *is* the human-meaningful dataset code
      // (e.g. "F-C0032-001"); for TDX it's just a REST URL prefix
      // ("v2/Bus/EstimatedTimeOfArrival/City") with no such code to show,
      // so `entry.id` ("tdx:bus-eta") is the more meaningful label here.
      dataset: busEtaEntry.id,
      cached,
      updateFrequency: busEtaEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatBusEtaText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
