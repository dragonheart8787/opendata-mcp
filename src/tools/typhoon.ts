import { cwaAdapter } from "../adapters/cwa.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { toToolError } from "../infra/errors.js";
import { typhoonNewsEntry, typhoonNewsInputShape, type TyphoonNewsResult, type TyphoonSummary } from "../registry/cwa.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

export { typhoonNewsInputShape };
export type { TyphoonNewsResult };

/**
 * Fetch + transform, no cache. Preserved as its own function (rather than
 * inlined into the tool handler below) so it can be unit-tested directly
 * against a mocked `fetchImpl`, same pattern as the other curated tools.
 */
export async function runTyphoon(apiKey: string | undefined, fetchImpl?: typeof fetch): Promise<TyphoonNewsResult> {
  const raw = await cwaAdapter.fetchDataset(typhoonNewsEntry, {}, { CWA_API_KEY: apiKey }, fetchImpl);
  return typhoonNewsEntry.transform(raw, {});
}

/**
 * The envelope's `issuedAt` is meant to be a single "as of" timestamp for the
 * whole response. This dataset has no single top-level publish time — each
 * active system carries its own latest analysis time — so this picks the
 * most recent one across all systems as the report's overall "as of" time.
 * `undefined` when there's no active system to report a time for.
 */
function latestIssuedAt(result: TyphoonNewsResult): string | undefined {
  const times = result.typhoons
    .map(typhoon => typhoon.latestPosition?.time)
    .filter((time): time is string => Boolean(time));
  if (times.length === 0) return undefined;
  return times.reduce((latest, current) => (new Date(current) > new Date(latest) ? current : latest));
}

function formatTyphoonSummary(typhoon: TyphoonSummary): string[] {
  const lines: string[] = [];
  const label = typhoon.name ?? typhoon.internationalName ?? `熱帶性低氣壓（編號 ${typhoon.cwaNumber ?? "不詳"}）`;
  lines.push(`## ${label}${typhoon.isNamedTyphoon ? "" : "（尚未達颱風強度或未命名）"}`);
  if (typhoon.internationalName && typhoon.name) {
    lines.push(`- 國際命名：${typhoon.internationalName}`);
  }
  if (typhoon.cwaNumber) {
    lines.push(`- 中央氣象署編號：${typhoon.cwaNumber}`);
  }
  if (typhoon.latestPosition) {
    const p = typhoon.latestPosition;
    lines.push(`- 最近一次分析時間：${p.time ?? "無資料"}`);
    lines.push(`- 中心位置：北緯 ${p.latitude ?? "?"} 度、東經 ${p.longitude ?? "?"} 度`);
    lines.push(`- 近中心最大風速：${p.maxWindSpeedMs ?? "無資料"} 公尺/秒`);
    lines.push(`- 最大陣風：${p.maxGustSpeedMs ?? "無資料"} 公尺/秒`);
    lines.push(`- 中心氣壓：${p.pressureHpa ?? "無資料"} 百帕`);
  } else {
    lines.push("- 無最新位置分析資料");
  }
  if (typhoon.forecastTrack.length > 0) {
    lines.push("- 中央氣象署路徑預測（轉載，非本伺服器推算）：");
    for (const point of typhoon.forecastTrack) {
      lines.push(
        `  - ${point.forecastHour ?? "?"} 小時後（基準時間 ${point.time ?? "無資料"}）：` +
          `北緯 ${point.latitude ?? "?"} 度、東經 ${point.longitude ?? "?"} 度，` +
          `最大風速 ${point.maxWindSpeedMs ?? "無資料"} 公尺/秒`
      );
    }
  }
  lines.push("");
  return lines;
}

export function formatTyphoonText(result: TyphoonNewsResult): string {
  if (!result.hasActiveSystem) {
    return "目前西北太平洋與南海沒有中央氣象署列管中的活動熱帶氣旋（含颱風與熱帶性低氣壓）。";
  }
  const issuedAt = latestIssuedAt(result);
  const lines = [
    "# 西北太平洋與南海活動中熱帶氣旋",
    "",
    "以下內容轉載自中央氣象署颱風消息，非本伺服器自行預測或判斷。",
    `發布時間（各系統最近一次分析時間中最新者）：${issuedAt ?? "無資料"}`,
    ""
  ];
  for (const typhoon of result.typhoons) {
    lines.push(...formatTyphoonSummary(typhoon));
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Composes cache + envelope on top of `runTyphoon`, for the MCP tool registration in index.ts. */
export async function handleTyphoonTool(env: Env, fetchImpl?: typeof fetch): Promise<McpToolResult> {
  try {
    const { value: data, cached } = await withCacheTracked(env.CACHE, "typhoon", typhoonNewsEntry.cacheTtlSeconds, () =>
      runTyphoon(env.CWA_API_KEY, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: "中央氣象署",
      dataset: typhoonNewsEntry.path,
      issuedAt: latestIssuedAt(data),
      cached,
      updateFrequency: typhoonNewsEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatTyphoonText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
