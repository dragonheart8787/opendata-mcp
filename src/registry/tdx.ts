import { z } from "zod";
import { BUS_ETA_CACHE_TTL_SECONDS, TDX_BUS_ETA_PATH_PREFIX, TDX_CITIES } from "../constants.js";
import { registerEntry, type DatasetEntry } from "./index.js";

// --- Bus/EstimatedTimeOfArrival/City/{City}: bus dynamic estimated arrival (SKELETON) ---
//
// Path confirmed via WebSearch against TDX's official Swagger docs and
// multiple independent integration guides this session (see
// TDX_BUS_ETA_PATH_PREFIX's comment in constants.ts) — not guessed from
// memory. The *response field* structure below is NOT yet confirmed
// against a real API response (the sandbox this session runs in has no
// network access to tdx.transportdata.tw, same restriction already
// documented for opendata.cwa.gov.tw / data.moenv.gov.tw), so this entry
// follows this project's established "skeleton + fixtures-refresh.yml
// dispatch" methodology: register with a pass-through transform now, get a
// real capture via a dispatched Actions run (which has unrestricted
// egress), then rewrite `transform`/`TdxBusEtaRawRecord` to match reality
// before this ships in a tool description that promises specific fields.
//
// TDX's REST convention embeds the primary selector (city) as a URL path
// segment rather than a query parameter — see `DatasetEntry.buildPathSegments`
// (registry/index.ts) and `buildTdxUrl` (adapters/tdx.ts) for the extension
// this required.

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
    .describe("公車路線名稱（例如「307」「紅29」），選填；不填則回傳該縣市所有路線的到站資訊。"),
  stopName: z.string().min(1).max(30).optional().describe("站牌名稱，選填，用於進一步篩選特定站牌的到站資訊。")
};

export interface BusEtaParams {
  city: string;
  routeName?: string;
  stopName?: string;
}

/**
 * SKELETON raw record type — deliberately `Record<string, unknown>` rather
 * than named fields, since the real field names/casing aren't confirmed yet
 * (see module comment above). Do not build a tool description around
 * specific fields until this has been replaced post-dispatch.
 */
export type TdxBusEtaRawRecord = Record<string, unknown>;

export interface BusEtaResult {
  [key: string]: unknown;
  query: { city: string; routeName?: string; stopName?: string };
  raw: TdxBusEtaRawRecord[];
}

export const busEtaEntry: DatasetEntry<BusEtaParams, TdxBusEtaRawRecord[], BusEtaResult> = {
  id: "tdx:bus-eta",
  source: "tdx",
  path: TDX_BUS_ETA_PATH_PREFIX,
  title: "公車動態預估到站時間",
  keywords: ["公車", "公車動態", "公車到站", "到站時間", "公車還有幾分鐘", "bus eta", "bus arrival", "bus estimated time"],
  paramsSchema: busEtaInputShape,
  buildQueryParams: () => ({ "$format": "JSON" }),
  buildPathSegments: params => [params.city],
  // SKELETON transform: pass the raw array straight through, tagged with
  // the query that produced it. Replaced with real field mapping + the
  // client-side re-filter required by AGENTS.md §6 once a real dispatch of
  // fixtures-refresh.yml confirms the actual response shape.
  transform: (raw, params) => ({
    query: { city: params.city, routeName: params.routeName, stopName: params.stopName },
    raw
  }),
  cacheTtlSeconds: BUS_ETA_CACHE_TTL_SECONDS,
  updateFrequency: "動態即時資料，隨各公車業者回報頻率更新（通常數十秒至數分鐘一次）",
  docUrl: "https://tdx.transportdata.tw/api-service/swagger/basic",
  notes:
    "SKELETON — 欄位結構尚未經真實 API 回應驗證，transform 目前僅原樣轉出 raw 陣列。" +
    "id 使用描述性 slug（tdx:bus-eta）而非官方資料集代碼，因為 TDX 的 API 是以路徑組織，" +
    "不像 CWA/MOENV 有統一的單一資料集代碼可用。",
  sampleParams: { city: "Taipei" },
  fixtureFileName: "bus-eta.json"
};

registerEntry(busEtaEntry as unknown as DatasetEntry<never, unknown, unknown>);
