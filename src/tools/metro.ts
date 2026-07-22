import { tdxAdapter } from "../adapters/tdx.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { toToolError } from "../infra/errors.js";
import {
  metroAlertEntry,
  metroStatusInputShape,
  type MetroStatusParams,
  type TdxMetroAlertRecord
} from "../registry/tdx.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

export { metroStatusInputShape };

export interface MetroStatusResult {
  [key: string]: unknown;
  query: { system: string };
  systemId: string | null;
  updateTime: string | null;
  /** Seconds — TDX's own self-reported batch republish interval, not inferred by this server. Null when the response didn't include one. */
  updateIntervalSeconds: number | null;
  alerts: TdxMetroAlertRecord[];
}

/**
 * Fetch + transform, no cache (this is a single-entry tool — metroAlertEntry
 * needs no join, unlike tw_youbike/tw_rail — so it just calls the registry
 * entry's own `transform` directly, same pattern as tw_typhoon's runTyphoon).
 */
export async function runMetroStatus(params: MetroStatusParams, env: Env, fetchImpl?: typeof fetch): Promise<MetroStatusResult> {
  const raw = await tdxAdapter.fetchDataset(metroAlertEntry, params, env, fetchImpl);
  const result = metroAlertEntry.transform(raw, params);
  return { query: { system: params.system }, ...result };
}

function formatAlertLine(alert: TdxMetroAlertRecord): string {
  const title = alert.Title ?? "（無標題）";
  const description = alert.Description && alert.Description !== alert.Title ? `：${alert.Description}` : "";
  const statusNote = alert.Status !== undefined ? `（狀態代碼 ${alert.Status}，未轉譯為文字，見工具說明）` : "";
  return `- ${title}${description}${statusNote}`;
}

export function formatMetroStatusText(result: MetroStatusResult): string {
  const lines = [`# 捷運即時營運狀態（${result.query.system}）`, ""];

  if (result.alerts.length === 0) {
    lines.push(
      "目前查無官方回報的即時營運狀態資訊。這不代表系統確定正常或異常，" +
        "僅代表本次查詢沒有取得任何狀態紀錄，可能是暫時性的資料落差，不代表本伺服器查詢失敗。"
    );
  } else {
    lines.push("以下逐字轉載交通部 TDX 目前公告的營運狀態，本伺服器不做額外判斷或摘要：");
    lines.push("");
    for (const alert of result.alerts) {
      lines.push(formatAlertLine(alert));
    }
  }

  lines.push("");
  lines.push(`資料更新時間：${result.updateTime ?? "無資料"}`);
  if (result.updateIntervalSeconds !== null) {
    lines.push(`⚠️ TDX 官方回報此資料約每 ${result.updateIntervalSeconds} 秒批次更新一次（非本伺服器推測），查詢結果可能落後實際狀況數十秒。`);
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Composes cache + envelope on top of `runMetroStatus`, for the MCP tool registration in index.ts. */
export async function handleMetroStatusTool(params: MetroStatusParams, env: Env, fetchImpl?: typeof fetch): Promise<McpToolResult> {
  try {
    const cacheKey = `metro-status:${params.system}`;
    const { value: data, cached } = await withCacheTracked(env.CACHE, cacheKey, metroAlertEntry.cacheTtlSeconds, () =>
      runMetroStatus(params, env, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: "交通部運輸資料流通服務",
      dataset: metroAlertEntry.id,
      cached,
      updateFrequency: metroAlertEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatMetroStatusText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
