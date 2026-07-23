import { z } from "zod";

import { HIGHWAY_LIVE_EVENTS_CACHE_TTL_SECONDS, HIGHWAY_LIVE_EVENTS_PATH } from "../constants.js";
import { registerEntry, type DatasetEntry } from "./index.js";

// --- history/motc20/LiveEvents.xml: national freeway live road events ---
//
// Real structure confirmed 2026-07-23 via a real fetch (see
// constants.ts's module comment on HIGHWAY_API_BASE_URL for how this path
// was actually found — it took a temporary debug route probing the real
// autoindex listing, not documentation). Sample response:
//
//   <LiveEventList>
//     <UpdateTime>2026-07-23T15:31:11+08:00</UpdateTime>
//     <UpdateInterval>60</UpdateInterval>
//     <AuthorityCode>NFB</AuthorityCode>
//     <LiveEvents>
//       <LiveEvent>
//         <EventID>A15040100H-01-20260723082311474100021</EventID>
//         <EventTitle>施工事件</EventTitle>
//         <Description>國道三號 北向 54K+400 施工事件-施工維護</Description>
//         <EventType>2</EventType>
//         <EventSubType>298</EventSubType>
//         ...
//         <Positions>POINT(121.323905 24.938822)</Positions>
//         <Location><FreeExpressHighway><Road>國道三號</Road>...</FreeExpressHighway></Location>
//         <Impact><Description>部分阻斷交通</Description><Severity>1</Severity>...</Impact>
//         ...
//       </LiveEvent>
//       ...
//     </LiveEvents>
//   </LiveEventList>
//
// EventType/EventSubType/LocationType/Severity/BlockWay are all numeric
// codes with no official decode table found — same discipline as
// tdx:bus-eta's StopStatus and tdx:road-traffic-cms's LocationType: kept
// as opaque passthrough fields, NOT translated into guessed Chinese
// severity labels. Every event conveniently already carries human-readable
// text (EventTitle/Description/Impact.Description) straight from the
// authority — those are what this entry surfaces as the primary content,
// with the numeric codes alongside for a caller who wants them.
//
// `Positions` is a WKT point (`POINT(lon lat)`), parsed here into
// `{ lon, lat }` — see `parseWktPoint` below.
//
// Nationwide, not per-city like every TDX entry in this project: there is
// no county/city field on any record (this is expected — it's a national
// freeway authority, not a city government). The only real per-record
// classification is `Location.FreeExpressHighway.Road` (e.g. "國道一號"),
// so that's the client-side filter this entry exposes, not a city enum —
// see `highwayLiveEventsInputShape.road` below. Per AGENTS.md §6, this is
// a client-side re-filter regardless: there's no upstream query parameter
// for road at all (the feed is always the complete nationwide list), so
// there's nothing upstream to distrust here the way there is for e.g.
// CWA/MOENV's `filters`/`locationName` — filtering happens here or nowhere.
//
// Long-tail-adjacent but curated (docs/ARCHITECTURE.md §3.1 vs §3.2): this
// gets a dedicated tool (`tw_highway_traffic`) rather than registry-only,
// since "is there a freeway incident right now" is exactly the kind of
// high-frequency real question this project's curated layer exists for —
// unlike tdx:road-traffic-cms, which turned out to be location-only data
// unable to answer that question and stayed registry-only as a result.
//
// This directory (`/history/motc20/`) also lists LiveTraffic.xml (speed/
// travel-time), News.xml (announcements), and Section.xml/SectionShape.xml
// (looks like static road-segment reference data) — deliberately NOT
// registered this round per the task that added this entry ("先只做
// LiveEvents.xml 這一個"). Real candidates for a future session, not
// investigated further here.
export const highwayLiveEventsInputShape = {
  road: z
    .string()
    .min(1)
    .optional()
    .describe(
      "選填，依國道名稱做部分字串篩選（例如「國道一號」「國道三號」）。此為本伺服器 client-side 篩選——" +
        "上游回應本身就是全國所有國道事件的單一清單，沒有依道路查詢的參數，也沒有縣市層級的篩選欄位可用" +
        "（這是全國性的國道事件資料，不像 TDX 資料集有縣市代碼）。不填則回傳全部（筆數依當下實際事件數量而定）。"
    )
};

export interface HighwayLiveEventsParams {
  road?: string;
}

export interface HighwayRampRawRecord {
  Direction?: string;
  EntryExit?: string;
}

export interface HighwayFreeExpressHighwayRawRecord {
  Road?: string;
  Direction?: string;
  StartKM?: string;
  EndKM?: string;
  Interchange?: string;
  Ramp?: HighwayRampRawRecord;
  SectionStart?: string;
  SectionEnd?: string;
}

export interface HighwayLocationRawRecord {
  FreeExpressHighway?: HighwayFreeExpressHighwayRawRecord;
}

export interface HighwayImpactRawRecord {
  Description?: string;
  Severity?: string;
  Regulations?: { Regulation?: string[] };
  BlockWay?: string;
  BlockedLanes?: string;
}

export interface HighwayLiveEventRawRecord {
  EventID?: string;
  EventTitle?: string;
  Description?: string;
  EventType?: string;
  EventSubType?: string;
  EventStep?: string;
  EffectiveTime?: string;
  /** WKT point, e.g. "POINT(121.323905 24.938822)" — see `parseWktPoint`. */
  Positions?: string;
  LocationType?: string;
  Location?: HighwayLocationRawRecord;
  Impact?: HighwayImpactRawRecord;
  Source?: string;
  PublishTime?: string;
  LastUpdateTime?: string;
}

export interface HighwayLiveEventListRawResponse {
  LiveEventList?: {
    UpdateTime?: string;
    /** Seconds, as a literal XML text digit string (e.g. "60") — TDX's own self-reported batch republish interval, not inferred by this server. */
    UpdateInterval?: string;
    AuthorityCode?: string;
    LiveEvents?: { LiveEvent?: HighwayLiveEventRawRecord[] };
  };
}

export interface HighwayLiveEventResult {
  [key: string]: unknown;
  eventId: string | null;
  title: string | null;
  description: string | null;
  /** Numeric code, opaque passthrough — no official decode table found. */
  eventType: string | null;
  /** Numeric code, opaque passthrough — no official decode table found. */
  eventSubType: string | null;
  effectiveTime: string | null;
  position: { lon: number; lat: number } | null;
  road: string | null;
  direction: string | null;
  startKm: string | null;
  endKm: string | null;
  interchange: string | null;
  sectionStart: string | null;
  sectionEnd: string | null;
  impactDescription: string | null;
  /** Numeric code, opaque passthrough — no official decode table found. */
  severity: string | null;
  /** Numeric code, opaque passthrough — no official decode table found. */
  blockWay: string | null;
  blockedLanes: string | null;
  publishTime: string | null;
  lastUpdateTime: string | null;
}

export interface HighwayLiveEventsResult {
  [key: string]: unknown;
  query: { road?: string };
  authorityCode: string | null;
  updateTime: string | null;
  updateIntervalSeconds: number | null;
  events: HighwayLiveEventResult[];
}

/** Parses a WKT point ("POINT(lon lat)") into `{ lon, lat }`. Returns null for anything else — this server never guesses at a malformed/unexpected coordinate string. */
function parseWktPoint(wkt: string | undefined): { lon: number; lat: number } | null {
  if (!wkt) {
    return null;
  }
  const match = /^POINT\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/.exec(wkt.trim());
  if (!match) {
    return null;
  }
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (Number.isNaN(lon) || Number.isNaN(lat)) {
    return null;
  }
  return { lon, lat };
}

function toEventResult(raw: HighwayLiveEventRawRecord): HighwayLiveEventResult {
  const highway = raw.Location?.FreeExpressHighway;
  const impact = raw.Impact;
  return {
    eventId: raw.EventID ?? null,
    title: raw.EventTitle ?? null,
    description: raw.Description ?? null,
    eventType: raw.EventType ?? null,
    eventSubType: raw.EventSubType ?? null,
    effectiveTime: raw.EffectiveTime ?? null,
    position: parseWktPoint(raw.Positions),
    road: highway?.Road ?? null,
    direction: highway?.Direction ?? null,
    startKm: highway?.StartKM ?? null,
    endKm: highway?.EndKM ?? null,
    interchange: highway?.Interchange ?? null,
    sectionStart: highway?.SectionStart ?? null,
    sectionEnd: highway?.SectionEnd ?? null,
    impactDescription: impact?.Description ?? null,
    severity: impact?.Severity ?? null,
    blockWay: impact?.BlockWay ?? null,
    blockedLanes: impact?.BlockedLanes ?? null,
    publishTime: raw.PublishTime ?? null,
    lastUpdateTime: raw.LastUpdateTime ?? null
  };
}

export const highwayLiveEventsEntry: DatasetEntry<HighwayLiveEventsParams, HighwayLiveEventListRawResponse, HighwayLiveEventsResult> = {
  id: "highway:live-events",
  source: "highway",
  path: HIGHWAY_LIVE_EVENTS_PATH,
  title: "國道即時交通事件（事故／施工／管制）",
  keywords: [
    "國道事故",
    "國道施工",
    "國道封閉",
    "國道路況",
    "國道管制",
    "高速公路事故",
    "高速公路施工",
    "highway incident",
    "freeway event",
    "national freeway traffic"
  ],
  paramsSchema: highwayLiveEventsInputShape,
  buildQueryParams: () => ({}),
  transform: (raw, params) => {
    const list = raw.LiveEventList;
    const rawEvents = list?.LiveEvents?.LiveEvent ?? [];
    const events = rawEvents
      .map(toEventResult)
      .filter(event => !params.road || (event.road !== null && event.road.includes(params.road)));
    return {
      query: { road: params.road },
      authorityCode: list?.AuthorityCode ?? null,
      updateTime: list?.UpdateTime ?? null,
      updateIntervalSeconds: list?.UpdateInterval ? Number(list.UpdateInterval) : null,
      events
    };
  },
  cacheTtlSeconds: HIGHWAY_LIVE_EVENTS_CACHE_TTL_SECONDS,
  updateFrequency:
    "動態即時資料，官方自行回報批次更新間隔約 60 秒（欄位 UpdateInterval，非本伺服器推測）。" +
    "官方使用規範規定重複擷取同一檔案的間距不得小於 40 秒，本伺服器的快取 TTL（60 秒）已保守高於此門檻。",
  docUrl: "https://tisvcloud.freeway.gov.tw/history/motc20/",
  notes:
    "資料來源：交通部高速公路局『交通資料庫』（tisvcloud.freeway.gov.tw），全平台無需金鑰/OAuth。" +
    "端點路徑非文件查得，而是透過本專案部署後的 Cloudflare Worker 實際探測 /history/motc20/ 目錄" +
    "（真實的 autoindex 清單）才找到——原本從第三方 R 套件線索猜測的 cctv_value.xml.gz 等檔名皆為錯誤路徑，" +
    "詳見 constants.ts 對 HIGHWAY_API_BASE_URL 的模組註解。" +
    "EventType/EventSubType/LocationType/Severity/BlockWay 均為數字代碼，無官方對照表可查，本伺服器僅原樣" +
    "轉載，不自行翻譯成中文分級文字；每筆事件本身已附人類可讀的 EventTitle/Description/Impact.Description，" +
    "以此為主要內容。全國性資料，無縣市欄位，僅能以國道名稱（road 參數）做 client-side 篩選。" +
    "同目錄下另有 LiveTraffic.xml（即時路況/車速）、News.xml（交通新聞公告）、Section.xml／" +
    "SectionShape.xml（看起來是靜態路段基礎資料）——這次任務範圍僅收錄 LiveEvents.xml，其餘留待未來" +
    "評估是否擴充。fixtures-refresh.yml 目前無法從 GitHub Actions 連到這個來源（見 AGENTS.md §6），" +
    "已設計成允許此來源的抓取失敗、不擋 CI；結構驗證改為部署後在正式環境（Cloudflare Workers）直接測試。",
  sampleParams: {},
  fixtureFileName: "highway-live-events.json"
};

registerEntry(highwayLiveEventsEntry as unknown as DatasetEntry<never, unknown, unknown>);
