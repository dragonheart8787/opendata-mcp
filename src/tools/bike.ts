import { tdxAdapter } from "../adapters/tdx.js";
import { YOUBIKE_MAX_STATIONS_RETURNED } from "../constants.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { toToolError } from "../infra/errors.js";
import {
  youBikeAvailabilityEntry,
  youBikeInputShape,
  youBikeStationEntry,
  type TdxBikeStationRawRecord,
  type YouBikeParams
} from "../registry/tdx.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

export { youBikeInputShape };

export interface YouBikeStationSummary {
  [key: string]: unknown;
  stationUid: string | null;
  stationName: string | null;
  stationNameEn: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  availableRentBikes: number | null;
  availableGeneralBikes: number | null;
  availableElectricBikes: number | null;
  availableReturnBikes: number | null;
  totalCapacity: number | null;
  updateTime: string | null;
}

export interface YouBikeResult {
  [key: string]: unknown;
  query: { city: string; stationName?: string };
  stations: YouBikeStationSummary[];
  totalMatched: number;
  truncated: boolean;
  /**
   * true when the station-metadata fetch (name/address/capacity) failed
   * but availability (bike counts) still succeeded — see runYouBike's doc
   * comment for why this degrades instead of failing the whole call.
   */
  stationMetadataUnavailable: boolean;
}

function matchesStationName(station: YouBikeStationSummary, keyword: string | undefined): boolean {
  if (!keyword) return true;
  const kw = keyword.toLowerCase();
  return (station.stationName?.includes(keyword) ?? false) || (station.stationNameEn?.toLowerCase().includes(kw) ?? false);
}

/**
 * Fetch both endpoints (availability + station metadata) and join them by
 * StationUID, no cache. A new pattern in this codebase — every prior
 * curated tool wraps exactly one registry entry, but Availability alone
 * has no station name (see registry/tdx.ts's module comment for why TDX
 * splits this dataset in two) — disclosed in the PR per AGENTS.md §7.3.
 * Directly unit-testable against a mocked `fetchImpl`, same pattern as the
 * other curated tools.
 *
 * The two fetches are NOT symmetric on failure. Availability carries the
 * actual answer to what this tool exists for (bike counts) — if it fails,
 * there's nothing useful to return, so that failure propagates and fails
 * the whole call, same as any other curated tool. Station metadata is
 * enrichment (name/address/capacity) — if only *that* fetch fails,
 * degrading to StationUID-only output (still real counts, just unnamed)
 * is more useful than discarding a successful Availability response over
 * an unrelated endpoint's outage. This also means a `stationName` filter
 * can't be honored when station metadata is unavailable (nothing has a
 * name to match against) — silently returning zero matches would be
 * misread as "no stations exist," so the filter is skipped instead and
 * `stationMetadataUnavailable` tells the caller why.
 */
export async function runYouBike(params: YouBikeParams, env: Env, fetchImpl?: typeof fetch): Promise<YouBikeResult> {
  const availabilityResult = await tdxAdapter.fetchDataset(youBikeAvailabilityEntry, { city: params.city }, env, fetchImpl);

  let stationResult: TdxBikeStationRawRecord[] = [];
  let stationMetadataUnavailable = false;
  try {
    stationResult = await tdxAdapter.fetchDataset(youBikeStationEntry, { city: params.city }, env, fetchImpl);
  } catch {
    stationMetadataUnavailable = true;
  }

  const stationByUid = new Map<string, TdxBikeStationRawRecord>();
  for (const station of stationResult) {
    if (station.StationUID) {
      stationByUid.set(station.StationUID, station);
    }
  }

  const joined: YouBikeStationSummary[] = availabilityResult.map(avail => {
    const station = avail.StationUID ? stationByUid.get(avail.StationUID) : undefined;
    return {
      stationUid: avail.StationUID ?? null,
      stationName: station?.StationName?.Zh_tw ?? null,
      stationNameEn: station?.StationName?.En ?? null,
      address: station?.StationAddress?.Zh_tw ?? null,
      latitude: station?.StationPosition?.PositionLat ?? null,
      longitude: station?.StationPosition?.PositionLon ?? null,
      availableRentBikes: avail.AvailableRentBikes ?? null,
      availableGeneralBikes: avail.AvailableRentBikesDetail?.GeneralBikes ?? null,
      availableElectricBikes: avail.AvailableRentBikesDetail?.ElectricBikes ?? null,
      availableReturnBikes: avail.AvailableReturnBikes ?? null,
      totalCapacity: station?.BikesCapacity ?? null,
      updateTime: avail.UpdateTime ?? null
    };
  });

  // Client-side stationName filtering — the only place it CAN happen,
  // since Availability alone has no name to filter by (see registry/tdx.ts)
  // — and per AGENTS.md §6, done unconditionally rather than trusting an
  // upstream filter this codebase never even attempts to send here.
  const effectiveStationNameFilter = stationMetadataUnavailable ? undefined : params.stationName;
  const matched = joined.filter(station => matchesStationName(station, effectiveStationNameFilter));
  const truncated = matched.length > YOUBIKE_MAX_STATIONS_RETURNED;

  return {
    query: { city: params.city, stationName: params.stationName },
    stations: matched.slice(0, YOUBIKE_MAX_STATIONS_RETURNED),
    totalMatched: matched.length,
    truncated,
    stationMetadataUnavailable
  };
}

function formatAvailability(station: YouBikeStationSummary): string {
  const rent = station.availableRentBikes ?? "無資料";
  const ret = station.availableReturnBikes ?? "無資料";
  const cap = station.totalCapacity ?? "無資料";
  const detail =
    station.availableGeneralBikes !== null || station.availableElectricBikes !== null
      ? `（一般 ${station.availableGeneralBikes ?? "無資料"} 輛、電輔 ${station.availableElectricBikes ?? "無資料"} 輛）`
      : "";
  return `可借 ${rent} 輛${detail}、可還 ${ret} 位（總車位數 ${cap}）`;
}

export function formatYouBikeText(result: YouBikeResult): string {
  if (result.stations.length === 0) {
    return (
      `目前查無符合條件的 YouBike 站點資料（城市：${result.query.city}` +
      `${result.query.stationName ? `，關鍵字：${result.query.stationName}` : ""}）。` +
      "可能是站名關鍵字有誤，或該站點目前非營運狀態，不代表本伺服器資料異常。"
    );
  }

  const lines = [`# YouBike 站點即時資訊（${result.query.city}）`, ""];
  if (result.stationMetadataUnavailable) {
    lines.push(
      "⚠️ 站點基本資料（站名/地址/總車位數）目前無法取得，以下僅顯示車柱代碼（StationUID）與即時可借還數量" +
        (result.query.stationName ? "；由於沒有站名可比對，本次查詢已忽略 stationName 篩選條件。" : "。")
    );
    lines.push("");
  }
  for (const station of result.stations) {
    const name = station.stationName ?? station.stationUid ?? "（未知站點）";
    lines.push(`- ${name}：${formatAvailability(station)}（更新時間：${station.updateTime ?? "無資料"}）`);
  }
  if (result.truncated) {
    lines.push("");
    lines.push(
      `⚠️ 符合條件的站點共 ${result.totalMatched} 筆，本回應僅顯示前 ${result.stations.length} 筆。` +
        "請提供 stationName 縮小查詢範圍以取得完整結果。"
    );
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Composes cache + envelope on top of `runYouBike`, for the MCP tool registration in index.ts. */
export async function handleYouBikeTool(params: YouBikeParams, env: Env, fetchImpl?: typeof fetch): Promise<McpToolResult> {
  try {
    const cacheKey = `youbike:${params.city}:${params.stationName ?? ""}`;
    const { value: data, cached } = await withCacheTracked(env.CACHE, cacheKey, youBikeAvailabilityEntry.cacheTtlSeconds, () =>
      runYouBike(params, env, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: "交通部運輸資料流通服務",
      // Not a single entry.path/entry.id — this tool joins two registry
      // entries (see runYouBike's doc comment), so there's no one
      // "dataset" to name. Disclosed deviation from every other tool's
      // single-entry dataset label.
      dataset: "tdx:youbike-availability + tdx:youbike-station",
      cached,
      updateFrequency: youBikeAvailabilityEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatYouBikeText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
