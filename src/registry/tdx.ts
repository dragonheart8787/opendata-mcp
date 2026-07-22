import { z } from "zod";
import {
  BUS_ETA_CACHE_TTL_SECONDS,
  BUS_ETA_MAX_STOPS_RETURNED,
  TDX_BIKE_AVAILABILITY_PATH_PREFIX,
  TDX_BUS_ETA_PATH_PREFIX,
  TDX_CITIES,
  YOUBIKE_CACHE_TTL_SECONDS_SKELETON,
  YOUBIKE_MAX_STATIONS_RETURNED
} from "../constants.js";
import { registerEntry, type DatasetEntry } from "./index.js";

// --- Bus/EstimatedTimeOfArrival/City/{City}[/{RouteName}]: bus dynamic estimated arrival ---
//
// Path confirmed via WebSearch against TDX's official Swagger docs and
// multiple independent integration guides (see TDX_BUS_ETA_PATH_PREFIX's
// comment in constants.ts). Response FIELD structure confirmed 2026-07-22
// via a real dispatch of fixtures-refresh.yml against the live API
// (this sandbox has no network access to tdx.transportdata.tw, same
// restriction already documented for opendata.cwa.gov.tw/data.moenv.gov.tw)
// — a bare JSON array (no CWA-style `{records}` wrapper), each item:
//   { StopUID, StopID, StopName: {Zh_tw, En}, RouteUID, RouteID,
//     RouteName: {Zh_tw, En}, Direction, EstimateTime?, StopStatus,
//     SrcUpdateTime, UpdateTime }
// `EstimateTime` (seconds until arrival) is genuinely absent — not null,
// not 0 — on many records; the real capture disproved the initially
// plausible-looking hypothesis "absent iff StopStatus != 0" (4,113 of
// 28,731 records in the Taipei-wide capture had StopStatus 1 *with* an
// EstimateTime present) — so this deliberately does NOT attempt to map
// StopStatus's numeric codes (0-4, all confirmed present in the real
// capture) to a human-readable reason, since the capture only proves the
// codes exist, not what each one reliably means for EstimateTime
// availability. Surfaced as a raw `stopStatusCode` instead of an invented
// label — see `formatBusEtaText` in tools/bus-eta.ts for how the UI text
// stays honest about what "no estimate" means without asserting why.
//
// An UNFILTERED city-only query is enormous — the real Taipei capture used
// to confirm this shape was 28,731 records / ~12.5MB, unusable as a
// committed fixture or a real tool response — so `sampleParams` narrows to
// a single real route ("615", confirmed to exist in that same capture,
// 78 records) via `buildPathSegments`, and `BUS_ETA_MAX_STOPS_RETURNED`
// caps the tool's own output regardless of how a caller queries.
//
// TDX's REST convention embeds selectors (city, optionally routeName) as
// URL path segments rather than query parameters — see
// `DatasetEntry.buildPathSegments` (registry/index.ts) and `buildTdxUrl`
// (adapters/tdx.ts) for the extension this required. Per AGENTS.md §6
// ("upstream filters aren't guaranteed to work" — previously verified for
// CWA/MOENV, status for TDX not independently confirmed this session),
// `transform` always re-filters client-side by routeName/stopName even
// though the routeName path segment is also sent upstream as a
// (plausible, TDX-documented) server-side filter.

export const busEtaInputShape = {
  city: z
    .enum(TDX_CITIES)
    .describe(
      "縣市英文代碼（TDX 標準代碼，例如「Taipei」「NewTaipei」「Taichung」「Kaohsiung」），必填。" +
        "注意這是 TDX 專用的英文代碼，不是 CWA 資料集使用的中文全形縣市名稱。"
    ),
  routeName: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "公車路線名稱（例如「615」「藍29」「重慶幹線」），選填但強烈建議提供——不填會查詢整個縣市所有路線，" +
        `資料量非常大，回應只會回傳前 ${BUS_ETA_MAX_STOPS_RETURNED} 筆並提示縮小查詢範圍。`
    ),
  stopName: z.string().min(1).max(30).optional().describe("站牌名稱，選填，用於進一步篩選特定站牌的到站資訊。")
};

export interface BusEtaParams {
  city: string;
  routeName?: string;
  stopName?: string;
}

interface TdxBilingualName {
  Zh_tw?: string;
  En?: string;
}

export interface TdxBusEtaRawRecord {
  StopUID?: string;
  StopID?: string;
  StopName?: TdxBilingualName;
  RouteUID?: string;
  RouteID?: string;
  RouteName?: TdxBilingualName;
  Direction?: number;
  /** Seconds until arrival. Genuinely absent (not null/0) when TDX has no current estimate — see module comment for why this isn't inferred from StopStatus. */
  EstimateTime?: number;
  StopStatus?: number;
  SrcUpdateTime?: string;
  UpdateTime?: string;
}

export interface BusEtaStop {
  [key: string]: unknown;
  routeName: string | null;
  routeNameEn: string | null;
  stopName: string | null;
  stopNameEn: string | null;
  direction: number | null;
  estimateSeconds: number | null;
  /** Raw TDX status code (0-4 per TDX's documented convention), not translated into text — see module comment. */
  stopStatusCode: number | null;
  updateTime: string | null;
}

export interface BusEtaResult {
  [key: string]: unknown;
  query: { city: string; routeName?: string; stopName?: string };
  stops: BusEtaStop[];
  totalMatched: number;
  truncated: boolean;
}

function matchesQuery(record: TdxBusEtaRawRecord, params: BusEtaParams): boolean {
  if (params.routeName && record.RouteName?.Zh_tw !== params.routeName && record.RouteName?.En !== params.routeName) {
    return false;
  }
  if (params.stopName && record.StopName?.Zh_tw !== params.stopName && record.StopName?.En !== params.stopName) {
    return false;
  }
  return true;
}

function summarizeStop(record: TdxBusEtaRawRecord): BusEtaStop {
  return {
    routeName: record.RouteName?.Zh_tw ?? null,
    routeNameEn: record.RouteName?.En ?? null,
    stopName: record.StopName?.Zh_tw ?? null,
    stopNameEn: record.StopName?.En ?? null,
    direction: record.Direction ?? null,
    estimateSeconds: typeof record.EstimateTime === "number" ? record.EstimateTime : null,
    stopStatusCode: record.StopStatus ?? null,
    updateTime: record.UpdateTime ?? null
  };
}

export const busEtaEntry: DatasetEntry<BusEtaParams, TdxBusEtaRawRecord[], BusEtaResult> = {
  id: "tdx:bus-eta",
  source: "tdx",
  path: TDX_BUS_ETA_PATH_PREFIX,
  title: "公車動態預估到站時間",
  keywords: ["公車", "公車動態", "公車到站", "到站時間", "公車還有幾分鐘", "bus eta", "bus arrival", "bus estimated time"],
  paramsSchema: busEtaInputShape,
  buildQueryParams: () => ({ "$format": "JSON" }),
  // routeName as a second path segment asks TDX to filter server-side too
  // (its documented convention) — `transform` below still always
  // re-filters client-side per AGENTS.md §6, since this wasn't
  // independently confirmed reliable for TDX this session.
  buildPathSegments: params => (params.routeName ? [params.city, params.routeName] : [params.city]),
  transform: (raw, params) => {
    const matched = raw.filter(record => matchesQuery(record, params));
    const truncated = matched.length > BUS_ETA_MAX_STOPS_RETURNED;
    return {
      query: { city: params.city, routeName: params.routeName, stopName: params.stopName },
      stops: matched.slice(0, BUS_ETA_MAX_STOPS_RETURNED).map(summarizeStop),
      totalMatched: matched.length,
      truncated
    };
  },
  cacheTtlSeconds: BUS_ETA_CACHE_TTL_SECONDS,
  updateFrequency: "動態即時資料，隨各公車業者回報頻率更新（實測約每 30 秒~1 分鐘一次）",
  docUrl: "https://tdx.transportdata.tw/api-service/swagger/basic/2998e851-81d0-40f5-b26d-77e2f5ac4118#/CityBus/CityBusApi_EstimatedTimeOfArrival_2032",
  notes:
    "欄位結構已於 2026-07-22 透過 fixtures-refresh.yml 真實 API 回應確認（Taipei 全市，28,731 筆）。" +
    "id 使用描述性 slug（tdx:bus-eta）而非官方資料集代碼，因為 TDX 的 API 是以路徑組織，" +
    "不像 CWA/MOENV 有統一的單一資料集代碼可用。StopStatus 數值代碼未轉譯為文字說明——" +
    "真實資料顯示 EstimateTime 是否存在與 StopStatus 數值沒有簡單對應關係，避免臆測語意。",
  sampleParams: { city: "Taipei", routeName: "615" },
  fixtureFileName: "bus-eta.json"
};

registerEntry(busEtaEntry as unknown as DatasetEntry<never, unknown, unknown>);

// --- Bike/Availability/{City}: public bike-sharing (YouBike etc.) real-time availability (SKELETON) ---
//
// Path confirmed via WebSearch against TDX's official Swagger docs and
// independent integration guides this session (see
// TDX_BIKE_AVAILABILITY_PATH_PREFIX's comment in constants.ts) — not
// guessed from memory. Note the shape difference from bus ETA: no literal
// "City/" segment before the city value (`.../Availability/{City}`, not
// `.../Availability/City/{City}`).
//
// The response FIELD structure is NOT yet confirmed against a real API
// response (same sandbox network restriction as every other TDX/CWA/MOENV
// entry in this project) — this follows the established "skeleton +
// fixtures-refresh.yml dispatch" methodology proven out for bus ETA:
// register with a pass-through transform now, get a real capture via a
// dispatched Actions run, then rewrite `transform`/`TdxYouBikeRawRecord` to
// match reality before this ships in a tool description that promises
// specific fields.
//
// Per WebSearch, TDX's bike endpoints document OData `$filter` support
// (e.g. `$filter=StationName eq '...'`) for station-level filtering —
// unlike bus ETA's routeName, which uses a URL path segment. This is a
// QUERY PARAMETER, not a path segment, so per AGENTS.md §6 ("upstream
// filters aren't guaranteed to work") this skeleton deliberately does NOT
// attempt to send a $filter this round — the exact field path/syntax
// TDX's OData parser expects isn't confirmed, and a malformed $filter
// value risks a 400 from TDX instead of silently degrading to
// "return everything," which is the whole reason to be cautious here.
// Whether an upstream $filter is worth attempting (and whether it's
// trustworthy if so) is exactly what this round's real dispatch is meant
// to help decide — see the follow-up commit's module comment for the
// resolution once real data is in hand.

export const youBikeInputShape = {
  city: z
    .enum(TDX_CITIES)
    .describe(
      "縣市英文代碼（TDX 標準代碼，例如「Taipei」「NewTaipei」「Taichung」「Kaohsiung」），必填。" +
        "注意這是 TDX 專用的英文代碼，不是 CWA 資料集使用的中文全形縣市名稱。"
    ),
  stationName: z
    .string()
    .min(1)
    .max(30)
    .optional()
    .describe(
      "站點名稱關鍵字，選填，做部分字串比對（例如「市政府」可比對到「YouBike2.0_捷運市政府站」），" +
        "不需要輸入完整站名。不填則回傳該縣市所有站點（可能筆數很多，回應會被截斷並提示縮小查詢範圍）。"
    )
};

export interface YouBikeParams {
  city: string;
  stationName?: string;
}

/**
 * SKELETON raw record type — deliberately `Record<string, unknown>` rather
 * than named fields, since the real field names/casing aren't confirmed yet
 * (see module comment above). Do not build a tool description around
 * specific fields until this has been replaced post-dispatch.
 */
export type TdxYouBikeRawRecord = Record<string, unknown>;

export interface YouBikeResult {
  [key: string]: unknown;
  query: { city: string; stationName?: string };
  raw: TdxYouBikeRawRecord[];
}

export const youBikeEntry: DatasetEntry<YouBikeParams, TdxYouBikeRawRecord[], YouBikeResult> = {
  id: "tdx:youbike",
  source: "tdx",
  path: TDX_BIKE_AVAILABILITY_PATH_PREFIX,
  title: "公共自行車（YouBike 等）即時車柱資訊",
  keywords: ["youbike", "公共自行車", "腳踏車", "共享單車", "還有車嗎", "還有位子嗎", "bike availability", "bike sharing"],
  paramsSchema: youBikeInputShape,
  buildQueryParams: () => ({ "$format": "JSON" }),
  buildPathSegments: params => [params.city],
  // SKELETON transform: pass the raw array straight through, tagged with
  // the query that produced it. Replaced with real field mapping + the
  // client-side filter required by AGENTS.md §6 once a real dispatch of
  // fixtures-refresh.yml confirms the actual response shape.
  transform: (raw, params) => ({
    query: { city: params.city, stationName: params.stationName },
    raw
  }),
  cacheTtlSeconds: YOUBIKE_CACHE_TTL_SECONDS_SKELETON,
  updateFrequency: "動態即時資料，確切更新頻率待真實 dispatch 確認",
  docUrl: "https://tdx.transportdata.tw/api-service/swagger/basic",
  notes:
    "SKELETON — 欄位結構尚未經真實 API 回應驗證，transform 目前僅原樣轉出 raw 陣列。" +
    "id 使用描述性 slug（tdx:youbike）而非官方資料集代碼，同 tdx:bus-eta 的理由。",
  sampleParams: { city: "Taipei" },
  fixtureFileName: "youbike.json"
};

registerEntry(youBikeEntry as unknown as DatasetEntry<never, unknown, unknown>);
