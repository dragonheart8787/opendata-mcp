import { z } from "zod";
import { tdxAdapter } from "../adapters/tdx.js";
import {
  RAIL_LIVEBOARD_DELAY_NOTICE,
  RAIL_LIVEBOARD_MAX_TRAINS_RETURNED,
  RAIL_STATION_AMBIGUOUS_CANDIDATES_SHOWN
} from "../constants.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { ToolError, toToolError } from "../infra/errors.js";
import {
  railTraLiveboardEntry,
  railTraStationEntry,
  type TdxRailTraLiveboardRawRecord,
  type TdxRailTraStationRawRecord
} from "../registry/tdx.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

export const railInputShape = {
  stationName: z
    .string()
    .min(1)
    .max(20)
    .describe(
      "要查詢的台鐵車站名稱（例如「臺北」「板橋」「左營」），必填。" +
        "可只輸入部分字串（例如「板橋」）——若比對到多個車站會回傳候選清單供縮小範圍；" +
        "若比對不到任何車站會回傳明確的查無結果，不代表本伺服器資料異常。"
    ),
  destinationStationName: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "選填，用於篩選開往特定終點站方向的車次（比對車次的終點站名稱，例如輸入「花蓮」只顯示開往花蓮方向的車次）。" +
        "這是本伺服器 client-side 篩選，不是 TDX 官方支援的查詢參數。"
    )
};

export interface RailParams {
  stationName: string;
  destinationStationName?: string;
}

export interface RailTrainSummary {
  [key: string]: unknown;
  trainNo: string | null;
  trainTypeName: string | null;
  trainTypeNameEn: string | null;
  /** Raw TDX direction code (0/1) — not translated into text, meaning not independently re-derived this session (see registry/tdx.ts's module comment). */
  direction: number | null;
  endingStationName: string | null;
  endingStationNameEn: string | null;
  scheduledArrivalTime: string | null;
  scheduledDepartureTime: string | null;
  /** Minutes late; 0 means on time (genuinely present as 0, not absent, when on schedule). */
  delayMinutes: number | null;
}

export interface RailResult {
  [key: string]: unknown;
  query: { stationName: string; destinationStationName?: string };
  station: { stationId: string; stationName: string | null; stationNameEn: string | null };
  trains: RailTrainSummary[];
  totalMatched: number;
  truncated: boolean;
  /** Batch-level UpdateTime shared by this fetch's train records (TDX republishes LiveBoard as one batch per station, confirmed in the real capture) — null when there were no trains to read it from. */
  dataUpdateTime: string | null;
  /**
   * The ~2-minute-delay / platform-display disclosure, fixed text, present
   * on every call (including zero-match results) — part of the response
   * DATA itself (see RAIL_LIVEBOARD_DELAY_NOTICE's comment in constants.ts
   * for why this can't live only in the tool description or formatted text).
   */
  delayNotice: string;
}

function matchesStationName(record: TdxRailTraStationRawRecord, needle: string): boolean {
  const zh = record.StationName?.Zh_tw;
  const en = record.StationName?.En;
  return zh === needle || en?.toLowerCase() === needle.toLowerCase();
}

function includesStationName(record: TdxRailTraStationRawRecord, needle: string): boolean {
  const zh = record.StationName?.Zh_tw;
  const en = record.StationName?.En;
  const lowerNeedle = needle.toLowerCase();
  return (zh?.includes(needle) ?? false) || (en?.toLowerCase().includes(lowerNeedle) ?? false);
}

/**
 * Resolves a caller-typed station name to the StationID railTraLiveboardEntry's
 * URL requires. Exact match (either language) wins outright; otherwise falls
 * back to substring match, which must land on exactly one station — zero
 * matches is NOT_FOUND, more than one is an INVALID_PARAMS error listing
 * candidates so the caller can be more specific. There is no partial/degraded
 * result here (unlike tw_youbike's asymmetric join): without a StationID
 * there is nothing to query LiveBoard for at all.
 */
function resolveStation(stationName: string, stations: TdxRailTraStationRawRecord[]): TdxRailTraStationRawRecord {
  const exact = stations.filter(s => matchesStationName(s, stationName));
  const candidates = exact.length > 0 ? exact : stations.filter(s => includesStationName(s, stationName));

  if (candidates.length === 0) {
    throw new ToolError({
      code: "NOT_FOUND",
      message: `查無車站名稱包含「${stationName}」的台鐵車站，請確認站名是否正確（例如使用「臺」而非「台」）。`
    });
  }

  if (candidates.length > 1) {
    const names = candidates
      .slice(0, RAIL_STATION_AMBIGUOUS_CANDIDATES_SHOWN)
      .map(s => s.StationName?.Zh_tw)
      .filter((name): name is string => !!name);
    throw new ToolError({
      code: "INVALID_PARAMS",
      message:
        `車站名稱「${stationName}」比對到多個候選車站，請提供更精確的站名：${names.join("、")}` +
        (candidates.length > names.length ? " 等" : "") +
        "。"
    });
  }

  return candidates[0];
}

function matchesDestination(train: TdxRailTraLiveboardRawRecord, keyword: string | undefined): boolean {
  if (!keyword) return true;
  const kw = keyword.toLowerCase();
  return (train.EndingStationName?.Zh_tw?.includes(keyword) ?? false) || (train.EndingStationName?.En?.toLowerCase().includes(kw) ?? false);
}

function summarizeTrain(train: TdxRailTraLiveboardRawRecord): RailTrainSummary {
  return {
    trainNo: train.TrainNo ?? null,
    trainTypeName: train.TrainTypeName?.Zh_tw ?? null,
    trainTypeNameEn: train.TrainTypeName?.En ?? null,
    direction: train.Direction ?? null,
    endingStationName: train.EndingStationName?.Zh_tw ?? null,
    endingStationNameEn: train.EndingStationName?.En ?? null,
    scheduledArrivalTime: train.ScheduledArrivalTime ?? null,
    scheduledDepartureTime: train.ScheduledDepartureTime ?? null,
    delayMinutes: typeof train.DelayTime === "number" ? train.DelayTime : null
  };
}

/**
 * Fetches both TRA endpoints (nationwide station list, then that station's
 * LiveBoard) and resolves the caller's station name in between — a hard
 * sequential dependency, not tw_youbike's optional-enrichment join (see
 * registry/tdx.ts's module comment on railTraStationEntry/
 * railTraLiveboardEntry). Either fetch failing, or the name failing to
 * resolve to exactly one station, fails the whole call: there is no
 * StationID to degrade to, unlike youBikeStationEntry's name/address being
 * skippable enrichment on top of an already-useful Availability response.
 */
export async function runRail(params: RailParams, env: Env, fetchImpl?: typeof fetch): Promise<RailResult> {
  const stations = await tdxAdapter.fetchDataset(railTraStationEntry, {}, env, fetchImpl);
  const station = resolveStation(params.stationName, stations);
  const stationId = station.StationID;
  if (!stationId) {
    throw new ToolError({
      code: "SCHEMA_MISMATCH",
      message: `找到車站「${station.StationName?.Zh_tw ?? params.stationName}」但缺少 StationID，無法查詢即時看板。`
    });
  }

  const rawTrains = await tdxAdapter.fetchDataset(railTraLiveboardEntry, { stationId }, env, fetchImpl);
  // Defensive re-filter to the requested StationID, same reasoning as
  // railTraLiveboardEntry.transform (registry/tdx.ts) — this curated tool
  // calls the adapter directly rather than going through that transform.
  const forThisStation = rawTrains.filter(t => t.StationID === stationId);
  const matched = forThisStation.filter(t => matchesDestination(t, params.destinationStationName));
  const truncated = matched.length > RAIL_LIVEBOARD_MAX_TRAINS_RETURNED;

  return {
    query: { stationName: params.stationName, destinationStationName: params.destinationStationName },
    station: {
      stationId,
      stationName: station.StationName?.Zh_tw ?? null,
      stationNameEn: station.StationName?.En ?? null
    },
    trains: matched.slice(0, RAIL_LIVEBOARD_MAX_TRAINS_RETURNED).map(summarizeTrain),
    totalMatched: matched.length,
    truncated,
    dataUpdateTime: forThisStation[0]?.UpdateTime ?? null,
    delayNotice: RAIL_LIVEBOARD_DELAY_NOTICE
  };
}

function formatTrainLine(train: RailTrainSummary): string {
  const type = train.trainTypeName ?? "（未知車種）";
  const no = train.trainNo ?? "（未知車次）";
  const dest = train.endingStationName ?? "（未知終點站）";
  const arrival = train.scheduledArrivalTime ?? "無資料";
  const departure = train.scheduledDepartureTime ?? "無資料";
  const delay = train.delayMinutes === null ? "無誤點資料" : train.delayMinutes === 0 ? "準點" : `誤點約 ${train.delayMinutes} 分鐘`;
  return `- ${type} ${no} 次（開往 ${dest}）：預計到站 ${arrival}／預計離站 ${departure}，${delay}`;
}

export function formatRailText(result: RailResult): string {
  const stationLabel = result.station.stationName ?? result.query.stationName;

  // The delay notice leads every response — including the zero-match case
  // — rather than trailing after a (possibly long) train list, so it isn't
  // the part most likely to get truncated or skimmed past. Sourced from
  // `result.delayNotice` (not a separate literal here) so the formatted
  // text and the structured data can never drift apart — see
  // RAIL_LIVEBOARD_DELAY_NOTICE's comment in constants.ts for why this must
  // be part of the response data at all, not just the tool description.
  if (result.trains.length === 0) {
    return (
      `${result.delayNotice}\n\n` +
      `目前查無「${stationLabel}」符合條件的台鐵即時到離站車次` +
      `${result.query.destinationStationName ? `（開往「${result.query.destinationStationName}」方向）` : ""}。` +
      "可能是該時段確實沒有相符車次（例如末班車已過、非尖峰時段班次較少），不代表本伺服器查詢失敗。"
    );
  }

  const lines = [result.delayNotice, "", `# 台鐵即時到離站看板（${stationLabel}）`, ""];
  for (const train of result.trains) {
    lines.push(formatTrainLine(train));
  }
  if (result.truncated) {
    lines.push("");
    lines.push(`⚠️ 符合條件的車次共 ${result.totalMatched} 筆，本回應僅顯示前 ${result.trains.length} 筆。`);
  }
  lines.push("");
  lines.push(`資料更新時間：${result.dataUpdateTime ?? "無資料"}`);
  return lines.join("\n").trimEnd() + "\n";
}

/** Composes cache + envelope on top of `runRail`, for the MCP tool registration in index.ts. */
export async function handleRailTool(params: RailParams, env: Env, fetchImpl?: typeof fetch): Promise<McpToolResult> {
  try {
    const cacheKey = `rail:${params.stationName}:${params.destinationStationName ?? ""}`;
    const { value: data, cached } = await withCacheTracked(env.CACHE, cacheKey, railTraLiveboardEntry.cacheTtlSeconds, () =>
      runRail(params, env, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: "交通部運輸資料流通服務",
      // Not a single entry.path/entry.id — this tool joins two registry
      // entries (see runRail's doc comment), same disclosed deviation as
      // tw_youbike.
      dataset: "tdx:rail-tra-station + tdx:rail-tra-liveboard",
      cached,
      updateFrequency: railTraLiveboardEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatRailText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
