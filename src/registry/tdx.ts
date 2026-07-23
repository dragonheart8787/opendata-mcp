import { z } from "zod";
import {
  BUS_ETA_CACHE_TTL_SECONDS,
  BUS_ETA_MAX_STOPS_RETURNED,
  METRO_ALERT_CACHE_TTL_SECONDS,
  RAIL_LIVEBOARD_CACHE_TTL_SECONDS,
  RAIL_TRA_STATION_CACHE_TTL_SECONDS,
  ROAD_TRAFFIC_CMS_CACHE_TTL_SECONDS,
  TDX_BIKE_AVAILABILITY_PATH_PREFIX,
  TDX_BIKE_STATION_PATH_PREFIX,
  TDX_BUS_ETA_PATH_PREFIX,
  TDX_CITIES,
  TDX_METRO_ALERT_PATH_PREFIX,
  TDX_METRO_SYSTEM_ID_BY_NAME,
  TDX_METRO_SYSTEMS,
  TDX_RAIL_TRA_LIVEBOARD_PATH_PREFIX,
  TDX_RAIL_TRA_STATION_PATH,
  TDX_ROAD_TRAFFIC_CMS_PATH_PREFIX,
  YOUBIKE_CACHE_TTL_SECONDS,
  YOUBIKE_STATION_CACHE_TTL_SECONDS
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

// --- Bike/Availability/City/{City} + Bike/Station/City/{City}: public bike-sharing (YouBike etc.) ---
//
// Path corrected 2026-07-22 after a real dispatch of fixtures-refresh.yml
// disproved the initial WebSearch-derived guess for Availability
// (`.../Availability/{City}`, no "City/" segment) with a genuine HTTP 404
// — see TDX_BIKE_AVAILABILITY_PATH_PREFIX's comment in constants.ts.
// Corrected to `.../Availability/City/{City}`, matching bus ETA's
// convention, and confirmed via a second real dispatch.
//
// Availability's real response (confirmed via that same dispatch) is a
// bare JSON array of:
//   { StationUID, StationID, ServiceStatus, ServiceType,
//     AvailableRentBikes, AvailableReturnBikes, SrcUpdateTime, UpdateTime,
//     AvailableRentBikesDetail: { GeneralBikes, ElectricBikes } }
// Critically — and this is exactly the kind of gap the skeleton+dispatch
// process exists to catch — **there is no station name field at all**.
// TDX splits bike-sharing data across two endpoints: Availability (dynamic
// counts only) and Station (static metadata: name/address/coordinates/
// capacity), the same "static vs. dynamic" split GTFS-realtime uses. A
// tool that promised "站名" per the task's requirement can't be built on
// Availability alone, so `youBikeStationEntry` below registers the
// metadata endpoint too (path assumed to follow the same confirmed
// `.../City/{City}` convention as bus ETA and bike availability — still a
// skeleton pending its own real-dispatch confirmation), and the curated
// `tw_youbike` tool (tools/bike.ts) fetches BOTH and joins them client-side
// by StationUID — a new pattern in this codebase (every prior curated tool
// wraps exactly one registry entry), disclosed here and in the PR per
// AGENTS.md §7.3.
//
// Neither entry attempts an upstream $filter (TDX's bike endpoints
// document OData `$filter` support, e.g. `$filter=StationName eq '...'`,
// but the exact field path/syntax wasn't independently confirmed this
// session, and a malformed $filter risks a 400 rather than a safe no-op)
// — `stationName` filtering happens entirely client-side in the tool layer
// after the join, per AGENTS.md §6.
//
// TTL evidence (from the real Availability capture, Taipei, 1,775
// stations): all 1,750 currently-in-service (ServiceStatus=1) stations
// shared the exact same `UpdateTime` value — TDX republishes this dataset
// as one batch, not per-station. The per-station `SrcUpdateTime` (each
// operator's own last-report time) to `UpdateTime` (TDX's batch time) gap
// had a median of 153s (~2.5 min), consistent with YouBike's own commonly
// documented ~1-minute refresh cadence. This is a coarser cadence than bus
// ETA's (~7s SrcUpdateTime-UpdateTime gap, TTL 30s) — evidence-based
// YOUBIKE_CACHE_TTL_SECONDS is set accordingly, not copied from bus ETA.
// (The 25 ServiceStatus=0 "not in service" stations had gaps up to ~510
// days — clearly stale/decommissioned entries, excluded from this
// reasoning as not representative of live cadence.)

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

export interface TdxBikeAvailabilityRawRecord {
  StationUID?: string;
  StationID?: string;
  /** 0 = 非營運中／已停用, 1 = 正常營運中— confirmed present in the real capture (both values seen), TDX's documented meaning not independently re-derived this session. */
  ServiceStatus?: number;
  /** Only value `2` observed in the real capture — meaning not confirmed, kept as an opaque passthrough rather than interpreted. */
  ServiceType?: number;
  AvailableRentBikes?: number;
  AvailableReturnBikes?: number;
  SrcUpdateTime?: string;
  UpdateTime?: string;
  AvailableRentBikesDetail?: { GeneralBikes?: number; ElectricBikes?: number };
}

export interface YouBikeAvailabilityResult {
  [key: string]: unknown;
  query: { city: string };
  stations: TdxBikeAvailabilityRawRecord[];
}

export const youBikeAvailabilityEntry: DatasetEntry<
  { city: string },
  TdxBikeAvailabilityRawRecord[],
  YouBikeAvailabilityResult
> = {
  id: "tdx:youbike-availability",
  source: "tdx",
  path: TDX_BIKE_AVAILABILITY_PATH_PREFIX,
  title: "公共自行車（YouBike 等）即時車柱可借還數量",
  keywords: ["youbike", "公共自行車", "腳踏車", "共享單車", "還有車嗎", "還有位子嗎", "bike availability", "bike sharing"],
  paramsSchema: { city: youBikeInputShape.city },
  buildQueryParams: () => ({ "$format": "JSON" }),
  buildPathSegments: params => [params.city],
  // No station name in this endpoint's own data (see module comment) — no
  // client-side name filter is possible here; tw_youbike (tools/bike.ts)
  // is where stationName filtering actually happens, after joining with
  // youBikeStationEntry.
  transform: (raw, params) => ({ query: { city: params.city }, stations: raw }),
  cacheTtlSeconds: YOUBIKE_CACHE_TTL_SECONDS,
  updateFrequency: "動態即時資料，TDX 以整批方式重新發布，實測批次時間間隔約 1-3 分鐘等級（詳見上方模組註解的證據）",
  docUrl: "https://tdx.transportdata.tw/api-service/swagger/basic",
  notes:
    "欄位結構已於 2026-07-22 透過 fixtures-refresh.yml 真實 API 回應確認（Taipei，1,775 站）。" +
    "此資料集本身不含站名——站名要透過 tdx:youbike-station 依 StationUID 對應，" +
    "tw_youbike 精選工具會自動 join 兩個資料集；本 entry 單獨透過 tw_query_dataset 查詢時只會拿到" +
    "車柱 ID 與可借還數量，不含站名。",
  sampleParams: { city: "Taipei" },
  fixtureFileName: "youbike-availability.json"
};

registerEntry(youBikeAvailabilityEntry as unknown as DatasetEntry<never, unknown, unknown>);

// --- Bike/Station/City/{City}: public bike-sharing station metadata ---
//
// Path (the assumed `.../City/{City}` convention) and field structure both
// confirmed 2026-07-22 via a real dispatch of fixtures-refresh.yml
// (Taipei, 1,775 stations) — a bare JSON array of:
//   { StationUID, StationID, AuthorityID, StationName: {Zh_tw, En},
//     StationPosition: {PositionLon, PositionLat, GeoHash},
//     StationAddress: {Zh_tw, En}, BikesCapacity, ServiceType,
//     SrcUpdateTime, UpdateTime }
// Same batch-publish pattern as availability: all 1,775 records shared one
// identical UpdateTime. `BikesCapacity` is the "總車位數" the task asked
// for — it lives here, not in Availability (see youBikeAvailabilityEntry's
// module comment for the full split story).

interface TdxBikeStationPosition {
  PositionLon?: number;
  PositionLat?: number;
  GeoHash?: string;
}

export interface TdxBikeStationRawRecord {
  StationUID?: string;
  StationID?: string;
  AuthorityID?: string;
  StationName?: TdxBilingualName;
  StationPosition?: TdxBikeStationPosition;
  StationAddress?: TdxBilingualName;
  BikesCapacity?: number;
  ServiceType?: number;
  SrcUpdateTime?: string;
  UpdateTime?: string;
}

export interface YouBikeStationResult {
  [key: string]: unknown;
  query: { city: string };
  stations: TdxBikeStationRawRecord[];
}

export const youBikeStationEntry: DatasetEntry<{ city: string }, TdxBikeStationRawRecord[], YouBikeStationResult> = {
  id: "tdx:youbike-station",
  source: "tdx",
  path: TDX_BIKE_STATION_PATH_PREFIX,
  title: "公共自行車（YouBike 等）站點基本資料",
  keywords: ["youbike 站點", "自行車站", "bike station", "youbike station"],
  paramsSchema: { city: youBikeInputShape.city },
  buildQueryParams: () => ({ "$format": "JSON" }),
  buildPathSegments: params => [params.city],
  transform: (raw, params) => ({ query: { city: params.city }, stations: raw }),
  cacheTtlSeconds: YOUBIKE_STATION_CACHE_TTL_SECONDS,
  updateFrequency: "站點基本資料，變動極少（新增/停用站點時才會變化），TDX 仍以整批方式定期重新發布",
  docUrl: "https://tdx.transportdata.tw/api-service/swagger/basic",
  notes:
    "欄位結構已於 2026-07-22 透過 fixtures-refresh.yml 真實 API 回應確認（Taipei，1,775 站）。" +
    "站名、地址、座標、總車位數皆在此資料集，即時可借還數量在 tdx:youbike-availability，" +
    "tw_youbike 精選工具會自動 join 兩者（依 StationUID）。",
  sampleParams: { city: "Taipei" },
  fixtureFileName: "youbike-station.json"
};

registerEntry(youBikeStationEntry as unknown as DatasetEntry<never, unknown, unknown>);

// --- Rail/TRA/Station + Rail/TRA/LiveBoard/Station/{StationID}: TRA (台鐵) real-time arrival/departure board ---
//
// Both paths confirmed via WebSearch against TDX's official Swagger docs
// and independent integration guides this session — not guessed from
// memory (see TDX_RAIL_TRA_STATION_PATH / TDX_RAIL_TRA_LIVEBOARD_PATH_PREFIX
// comments in constants.ts). Response FIELD structure confirmed 2026-07-22
// via a real dispatch of fixtures-refresh.yml (Taipei Station StationID
// "1000" for LiveBoard, no params for the nationwide Station list — both
// sampleParams guesses worked on the first try, no 404s).
//
// Why two entries: LiveBoard's URL requires a numeric StationID
// (`/LiveBoard/Station/{StationID}`), not the station NAME a caller would
// actually type (e.g. "臺北"). `railTraStationEntry` is the nationwide
// name->ID lookup tw_rail (tools/rail.ts) resolves against first — but
// unlike tw_youbike's join (registry/index.ts's §2 note in AGENTS.md),
// this is NOT an optional-enrichment join: the station list isn't
// decorating an already-useful Availability response, it's a hard
// prerequisite for even knowing which StationID to ask LiveBoard for. If
// either fetch fails, tw_rail has nothing to degrade to — both failures
// propagate and fail the whole call, unlike youBikeAvailabilityEntry/
// youBikeStationEntry's asymmetric handling.
//
// THSR (高鐵) is deliberately NOT covered this session — see
// TDX_RAIL_TRA_LIVEBOARD_PATH_PREFIX's comment in constants.ts for why
// (no equivalent live delay-board endpoint found; THSR's TDX endpoints are
// structurally different — scheduled DailyTimetable + seat inventory, not
// a real-time delay board).
//
// TDX's own documentation states TRA LiveBoard carries a known ~2 minute
// latency and isn't guaranteed to exactly match a station's own physical
// platform display (TIDS) — already confirmed by the task that scoped
// this session, not re-searched. This MUST be disclosed in tw_rail's tool
// description (docs/ARCHITECTURE.md §0's "忠實轉載，不誇大即時性" spirit,
// same compliance discipline as the typhoon/weather-warning tools), AND —
// learned the hard way in production, see RAIL_LIVEBOARD_DELAY_NOTICE's
// comment in constants.ts — as a fixed field in tw_rail's own response DATA
// (RailResult.delayNotice, tools/rail.ts), since a tool `description` only
// guides the calling LLM and isn't guaranteed to be relayed to the end
// user. Not just noted here.
//
// Real LiveBoard capture (Taipei Station, 8 trains) confirms there is NO
// platform/月台 field in this response at all — TDX's LiveBoard only
// carries schedule/delay/direction data, not platform assignment. tw_rail's
// description must not promise platform info this endpoint doesn't have.

export const railStationInputShape = {};

export type RailStationParams = Record<string, never>;

interface TdxRailStationPosition {
  PositionLon?: number;
  PositionLat?: number;
  GeoHash?: string;
}

/** Confirmed via the real capture (245 nationwide TRA stations): StationAddress and StationPhone are genuinely absent (not empty string) on some records — e.g. unstaffed halts like 三坑/1998 樹林調車場. */
export interface TdxRailTraStationRawRecord {
  StationUID?: string;
  StationID?: string;
  StationName?: TdxBilingualName;
  StationAddress?: string;
  StationPhone?: string;
  OperatorID?: string;
  StationClass?: string;
  StationPosition?: TdxRailStationPosition;
  LocationCity?: string;
  LocationCityCode?: string;
  LocationTown?: string;
  LocationTownCode?: string;
  UpdateTime?: string;
  VersionID?: number;
}

export interface RailTraStationResult {
  [key: string]: unknown;
  stations: TdxRailTraStationRawRecord[];
}

export const railTraStationEntry: DatasetEntry<RailStationParams, TdxRailTraStationRawRecord[], RailTraStationResult> = {
  id: "tdx:rail-tra-station",
  source: "tdx",
  path: TDX_RAIL_TRA_STATION_PATH,
  title: "台鐵車站基本資料",
  keywords: ["台鐵車站", "火車站", "tra station", "rail station"],
  paramsSchema: railStationInputShape,
  buildQueryParams: () => ({ "$format": "JSON" }),
  // No buildPathSegments — this is a single nationwide list, no per-request path segment.
  transform: raw => ({ stations: raw }),
  cacheTtlSeconds: RAIL_TRA_STATION_CACHE_TTL_SECONDS,
  updateFrequency: "車站基本資料，變動極少（新增/停用車站時才會變化）",
  docUrl: "https://tdx.transportdata.tw/api-service/swagger/basic",
  notes:
    "欄位結構已於 2026-07-22 透過 fixtures-refresh.yml 真實 API 回應確認（全國 245 站）。" +
    "StationAddress/StationPhone 在部分站點（例如無人招呼站）真的不存在，非欄位遺漏。" +
    "tw_rail 精選工具用此資料集把使用者輸入的車站名稱解析成 LiveBoard 端點需要的 StationID。",
  sampleParams: {},
  fixtureFileName: "rail-tra-station.json"
};

registerEntry(railTraStationEntry as unknown as DatasetEntry<never, unknown, unknown>);

export interface RailLiveboardParams {
  stationId: string;
}

/** Confirmed via the real capture (Taipei Station, 8 trains): NO platform/月台 field in this response — see module comment above. */
export interface TdxRailTraLiveboardRawRecord {
  StationID?: string;
  StationName?: TdxBilingualName;
  TrainNo?: string;
  /** 0/1 observed in the real capture — TDX's documented meaning (going/returning direction relative to the line) not independently re-derived this session, kept as an opaque passthrough. */
  Direction?: number;
  TrainTypeID?: string;
  TrainTypeCode?: string;
  TrainTypeName?: TdxBilingualName;
  /** 0/1 observed — same "kept opaque, not re-derived" treatment as Direction. */
  TripLine?: number;
  EndingStationID?: string;
  EndingStationName?: TdxBilingualName;
  /** HH:mm:ss, no date — only ever absent for a train's originating station in TDX's documented convention (not observed absent in this session's 8-record capture, but handled defensively since a crash on one train shouldn't fail the whole board). */
  ScheduledArrivalTime?: string;
  ScheduledDepartureTime?: string;
  /** Minutes late; 0 = on time. Genuinely present as 0, not absent, when on schedule (confirmed in the real capture). */
  DelayTime?: number;
  SrcUpdateTime?: string;
  UpdateTime?: string;
}

export interface RailTraLiveboardResult {
  [key: string]: unknown;
  trains: TdxRailTraLiveboardRawRecord[];
}

export const railTraLiveboardEntry: DatasetEntry<
  RailLiveboardParams,
  TdxRailTraLiveboardRawRecord[],
  RailTraLiveboardResult
> = {
  id: "tdx:rail-tra-liveboard",
  source: "tdx",
  path: TDX_RAIL_TRA_LIVEBOARD_PATH_PREFIX,
  title: "台鐵即時到離站看板",
  keywords: ["台鐵", "台鐵誤點", "台鐵到站", "火車到站", "台鐵時刻", "tra liveboard", "train delay"],
  paramsSchema: { stationId: z.string().min(1) },
  buildQueryParams: () => ({ "$format": "JSON" }),
  buildPathSegments: params => [params.stationId],
  // Defensive client-side re-filter to the requested StationID — the real
  // capture confirmed every returned record already matched (TDX's path
  // segment IS a real server-side filter here, unlike a query-param
  // `filters` this project has independently found unreliable elsewhere,
  // see AGENTS.md §6), but this is cheap insurance against a future
  // upstream regression silently mixing in another station's trains.
  transform: (raw, params) => ({ trains: raw.filter(t => t.StationID === params.stationId) }),
  cacheTtlSeconds: RAIL_LIVEBOARD_CACHE_TTL_SECONDS,
  updateFrequency: "動態即時資料，官方文件註明約 2 分鐘延遲",
  docUrl: "https://tdx.transportdata.tw/api-service/swagger/basic",
  notes:
    "欄位結構已於 2026-07-22 透過 fixtures-refresh.yml 真實 API 回應確認（臺北車站，8 個車次）。" +
    "確認回應中沒有月台/Platform 欄位——TDX 此端點只提供時刻/誤點/方向資料，不含月台配置。" +
    "StationID 為必填路徑參數，須先透過 tdx:rail-tra-station 把站名解析成 StationID" +
    "（tw_rail 精選工具會自動處理，直接用此 entry 透過 tw_query_dataset 查詢則需自行提供 StationID）。" +
    "官方文件註明資料約有 2 分鐘延遲，且不保證與車站月台實際看板完全一致。",
  // "1000" (Taipei Station) confirmed correct by the real dispatch — see
  // module comment above.
  sampleParams: { stationId: "1000" },
  fixtureFileName: "rail-tra-liveboard.json"
};

registerEntry(railTraLiveboardEntry as unknown as DatasetEntry<never, unknown, unknown>);

// --- Rail/Metro/Alert/{systemId}: Metro (捷運) real-time operational status / service disruption feed ---
//
// Path confirmed via WebSearch, not memory — see TDX_METRO_ALERT_PATH_PREFIX's
// comment in constants.ts for the full provenance note (an official
// tdx.transportdata.tw topic page's own title is the source of the literal
// path, since this sandbox can't fetch that domain directly). Response FIELD
// structure confirmed 2026-07-22 via a real dispatch of fixtures-refresh.yml
// (Taipei/TRTC) — see the real capture below, this is NOT the bare-array
// shape every other TDX entry in this project has: it's a single object
// (batch metadata + an `Alerts` array), the first TDX response shaped this
// way encountered in this codebase.
//
//   {
//     UpdateTime, UpdateInterval, SrcUpdateTime, SrcUpdateInterval,
//     AuthorityCode,
//     Alerts: [{ AlertID, Title, Description, Status,
//       Scope: { Network, Stations, Lines, Routes, Trains, LineSections },
//       PublishTime, UpdateTime }]
//   }
//
// Deliberately the dynamic Alert/disruption feed, not the static
// Line/Station/Network endpoints also found via WebSearch — this session's
// task asks "is the metro running normally right now", which a route-map
// dataset can't answer. A second, joined entry (line/station names) turns
// out NOT necessary: `Title`/`Description` are already plain human-readable
// text (not bilingual-object-keyed like StationName elsewhere in this
// project, and not bare IDs needing a name lookup) — the real capture's one
// current alert reads verbatim "正常營運" in both fields. tw_metro_status
// relays these as-is rather than joining anything, per AGENTS.md §2.
//
// `Status` is a numeric code (1 confirmed = normal operation, from the real
// capture's Title/Description context) — same discipline as bus ETA's
// StopStatus and TRA LiveBoard's Direction: kept as an opaque passthrough,
// not translated into other states, since only one value has independently
// confirmed real-world meaning. There's also no real captured example of an
// actual disruption (TRTC was operating normally at capture time), so
// `Scope`'s populated-vs-empty behavior during a real incident is unverified
// — modeled permissively (everything optional) rather than guessed.
//
// Only three systems this session (per the task's scope): 台北/高雄/桃園,
// mapped to TDX's systemId codes (TRTC/KRTC/TYMC) via
// TDX_METRO_SYSTEM_ID_BY_NAME — see that constant's comment for why
// Taichung is excluded. Unlike TDX_CITIES (TDX's own English city codes,
// used directly as the caller-facing param because that's what the bus/bike
// endpoints themselves require), the Chinese system name here is a
// convenience layer this server invents — the task explicitly asked for
// "system（捷運系統，例如台北/高雄/桃園）", not the raw TDX code a caller
// would have no reason to already know.
//
// No client-side re-filter (unlike every array-based TDX entry in this
// project, per AGENTS.md §6) — there's structurally nothing to re-filter:
// the response is a single object for the one requested systemId, not a
// list that could contain other systems' entries mixed in.
//
// No official "known ~N minute delay" caveat for this dataset was found via
// WebSearch (unlike TRA LiveBoard's pre-confirmed ~2 minute latency) — but
// the real capture turned up something better than a caveat would have
// been: TDX's own response HONESTLY self-reports its batch cadence via
// `UpdateInterval`/`SrcUpdateInterval` (60 seconds, confirmed real values).
// Rather than inventing a fixed disclaimer sentence the way tw_rail's
// RAIL_LIVEBOARD_DELAY_NOTICE had to (see that constant's comment in
// constants.ts for why a description-only disclosure wasn't enough there),
// tw_metro_status surfaces this self-reported interval directly as
// structured data (`updateIntervalSeconds` in tools/metro.ts) — the actual
// evidence, not a canned caveat standing in for it.

export const metroStatusInputShape = {
  system: z
    .enum(TDX_METRO_SYSTEMS)
    .describe(
      "捷運系統名稱，目前支援「台北」「高雄」「桃園」，必填。" +
        "這是給人看的中文系統名稱，不是 TDX 內部的 systemId 代碼（例如 TRTC），伺服器會自動轉換。"
    )
};

export interface MetroStatusParams {
  system: (typeof TDX_METRO_SYSTEMS)[number];
}

export interface TdxMetroAlertScope {
  Network?: Record<string, unknown>;
  Stations?: unknown[];
  Lines?: unknown[];
  Routes?: unknown[];
  Trains?: unknown[];
  LineSections?: unknown[];
}

export interface TdxMetroAlertRecord {
  AlertID?: string;
  /** Short label, plain text (not bilingual-object-keyed) — confirmed via the real capture: "正常營運" for the one currently-active normal-operation alert. */
  Title?: string;
  /** Longer text, plain text — same field in the real capture repeats Title verbatim when nothing's wrong. */
  Description?: string;
  /** Numeric status code — only 1 (normal operation) independently confirmed; kept opaque, not translated (see module comment). */
  Status?: number;
  Scope?: TdxMetroAlertScope;
  PublishTime?: string;
  UpdateTime?: string;
}

/** Top-level shape is a single object, not a bare array — the first TDX response in this project shaped this way. See module comment above. */
export interface TdxMetroAlertRawResponse {
  UpdateTime?: string;
  /** Seconds — TDX's own self-reported batch republish interval (60 in the real capture). This is the TTL evidence, not an inferred gap. */
  UpdateInterval?: number;
  SrcUpdateTime?: string;
  SrcUpdateInterval?: number;
  AuthorityCode?: string;
  Alerts?: TdxMetroAlertRecord[];
}

export interface MetroAlertResult {
  [key: string]: unknown;
  systemId: string | null;
  updateTime: string | null;
  updateIntervalSeconds: number | null;
  alerts: TdxMetroAlertRecord[];
}

export const metroAlertEntry: DatasetEntry<MetroStatusParams, TdxMetroAlertRawResponse, MetroAlertResult> = {
  id: "tdx:metro-alert",
  source: "tdx",
  path: TDX_METRO_ALERT_PATH_PREFIX,
  title: "捷運營運通阻（即時營運狀態）",
  keywords: ["捷運", "捷運誤點", "捷運事故", "捷運正常嗎", "捷運狀態", "metro alert", "mrt status", "mrt disruption"],
  paramsSchema: metroStatusInputShape,
  buildQueryParams: () => ({ "$format": "JSON" }),
  buildPathSegments: params => [TDX_METRO_SYSTEM_ID_BY_NAME[params.system]],
  transform: raw => ({
    systemId: raw.AuthorityCode ?? null,
    updateTime: raw.UpdateTime ?? null,
    updateIntervalSeconds: raw.UpdateInterval ?? null,
    alerts: raw.Alerts ?? []
  }),
  cacheTtlSeconds: METRO_ALERT_CACHE_TTL_SECONDS,
  updateFrequency: "動態即時資料，TDX 自行回報批次更新間隔約 60 秒（欄位 UpdateInterval，非本伺服器推測）",
  docUrl: "https://tdx.transportdata.tw/api-service/swagger/basic",
  notes:
    "欄位結構已於 2026-07-22 透過 fixtures-refresh.yml 真實 API 回應確認（Taipei/TRTC）。" +
    "回應為單一物件（非本專案其他 TDX entry 常見的裸陣列），Title/Description 為純文字" +
    "（非雙語物件），已如實轉載，未做語意翻譯。Status 數值代碼僅確認過 1（正常營運），" +
    "未轉譯為其他狀態文字。system 參數為中文系統名稱（台北/高雄/桃園），" +
    "tw_metro_status 精選工具會自動轉換成 TDX 的 systemId。",
  sampleParams: { system: "台北" },
  fixtureFileName: "metro-alert.json"
};

registerEntry(metroAlertEntry as unknown as DatasetEntry<never, unknown, unknown>);

// tdx:parking-offstreet-carpark was investigated and deliberately NOT
// registered — the endpoint (v1/Parking/OffStreet/CarPark/City/{City})
// responds correctly, but two independent real dispatches (Taipei, New
// Taipei) both came back with an empty CarParks array, so no real
// per-record field structure was ever observed. See
// TDX_PARKING_OFFSTREET_CARPARK_PATH_PREFIX's comment history / the PR for
// the full story — kept out rather than registered as a permanently-empty
// skeleton with an unconfirmed record shape (AGENTS.md §5).

// --- Road/Traffic/CMS/City/{City}: road changeable message sign locations (可變訊息標誌位置) ---
//
// Path extrapolated from a WebSearch-confirmed sibling convention, not
// memory — see TDX_ROAD_TRAFFIC_CMS_PATH_PREFIX's comment in constants.ts
// for the full provenance note and the explicit disclosure that this is a
// weaker evidence tier than every other entry in this project (CCTV's
// exact path was confirmed via a literal real URL; CMS's suffix is
// inferred from that confirmed sibling pattern, not independently observed
// itself — but the real dispatch confirmed the guess was right: a 200 with
// real data, not a 404).
//
// Field structure confirmed 2026-07-23 via a real dispatch of
// fixtures-refresh.yml (Taipei, ~180 records) — and it forced a real
// correction to what this entry even IS. The original plan (per the task
// that scoped this session) was for this to stand in for "道路交通事件/
// 施工封路" — but the real response contains ONLY sign-location metadata
// (CMSID, LinkID, LocationType, coordinates, optional RoadID/RoadName/
// RoadClass/RoadDirection), never the message text actually displayed on
// a sign. There is no field here that says what a sign is warning about,
// so this dataset does NOT answer "is there an incident/closure right
// now" — it only answers "where are the CMS signs." Title, keywords, and
// notes below were rewritten after this discovery to stop implying board
// content this endpoint doesn't have; see the PR for the full accounting
// of what was asked for vs. what's actually available. No distinct
// "TrafficEvent"-style resource was found anywhere in TDX's Road Traffic
// v2 group despite extensive searching (the only adjacent hit was a
// reporting/admin backend for authorities to file incidents, not a public
// read API) — this remains the closest real substitute found.
//
// Long-tail entry per docs/ARCHITECTURE.md §3.2 — registry-only, no
// curated tool. No per-record city/county field exists to defensively
// re-filter on (per AGENTS.md §6) — the only city signal is the top-level
// `AuthorityCode`, which a caller can sanity-check against what they asked
// for, but there's nothing at the record level to filter.

export const roadTrafficCmsInputShape = {
  city: z
    .enum(TDX_CITIES)
    .describe(
      "縣市英文代碼（TDX 標準代碼，例如「Taipei」「NewTaipei」「Taichung」「Kaohsiung」），必填。" +
        "注意這是 TDX 專用的英文代碼，不是 CWA 資料集使用的中文全形縣市名稱。"
    )
};

export interface RoadTrafficCmsParams {
  city: string;
}

/** Confirmed via the real capture: RoadID/RoadName/RoadClass/RoadDirection are genuinely absent on some records (e.g. minor links with no named road association), not a fixture gap. */
export interface TdxRoadTrafficCmsSignRawRecord {
  CMSID?: string;
  LinkID?: string;
  /** Numeric code, 1-6 observed in the real capture — meaning not independently confirmed, kept as an opaque passthrough (same discipline as bus ETA's StopStatus). */
  LocationType?: number;
  PositionLon?: number;
  PositionLat?: number;
  RoadID?: string;
  RoadName?: string;
  RoadClass?: number;
  /** Compass direction string (e.g. "E", "NW") observed in the real capture. */
  RoadDirection?: string;
}

export interface TdxRoadTrafficCmsRawResponse {
  UpdateTime?: string;
  /** Seconds — TDX's own self-reported batch republish interval (21600/6h in the real capture). */
  UpdateInterval?: number;
  SrcUpdateTime?: string;
  SrcUpdateInterval?: number;
  AuthorityCode?: string;
  CMSs?: TdxRoadTrafficCmsSignRawRecord[];
}

export interface RoadTrafficCmsResult {
  [key: string]: unknown;
  query: { city: string };
  authorityCode: string | null;
  updateTime: string | null;
  updateIntervalSeconds: number | null;
  signs: TdxRoadTrafficCmsSignRawRecord[];
}

export const roadTrafficCmsEntry: DatasetEntry<RoadTrafficCmsParams, TdxRoadTrafficCmsRawResponse, RoadTrafficCmsResult> = {
  id: "tdx:road-traffic-cms",
  source: "tdx",
  path: TDX_ROAD_TRAFFIC_CMS_PATH_PREFIX,
  title: "道路可變訊息標誌（CMS）設置位置",
  keywords: ["可變訊息標誌", "CMS", "道路電子看板位置", "traffic message sign location", "CMS location"],
  paramsSchema: roadTrafficCmsInputShape,
  buildQueryParams: () => ({ "$format": "JSON" }),
  buildPathSegments: params => [params.city],
  transform: (raw, params) => ({
    query: { city: params.city },
    authorityCode: raw.AuthorityCode ?? null,
    updateTime: raw.UpdateTime ?? null,
    updateIntervalSeconds: raw.UpdateInterval ?? null,
    signs: raw.CMSs ?? []
  }),
  cacheTtlSeconds: ROAD_TRAFFIC_CMS_CACHE_TTL_SECONDS,
  updateFrequency: "近靜態位置資料，TDX 自行回報批次更新間隔約 6 小時（欄位 UpdateInterval，非本伺服器推測）",
  docUrl: "https://tdx.transportdata.tw/api-service/swagger/basic",
  notes:
    "欄位結構已於 2026-07-23 透過 fixtures-refresh.yml 真實 API 回應確認（Taipei，約 180 筆）。" +
    "**重要**：真實回應只有可變訊息標誌的設置位置（座標、所在路段），完全沒有看板目前顯示的文字內容，" +
    "因此**無法用來回答「現在有沒有事故/施工」**——這是本 session 原本想找的「道路交通事件/施工封路」" +
    "資料集查證後最接近的真實替代資料，但實際內容與原始設想不同，已誠實調整標題與說明。" +
    "回應為單一物件（非本專案其他 TDX entry 常見的裸陣列），LocationType 數值代碼未轉譯為文字說明。" +
    "無逐筆縣市欄位可做 client-side 保底重新篩選，僅有整批層級的 AuthorityCode 可供比對。",
  sampleParams: { city: "Taipei" },
  fixtureFileName: "road-traffic-cms.json"
};

registerEntry(roadTrafficCmsEntry as unknown as DatasetEntry<never, unknown, unknown>);
