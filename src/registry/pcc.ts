import { z } from "zod";

import {
  PCC_COPYRIGHT_NOTICE,
  PCC_SITE_BASE_URL,
  PCC_SOURCE_NOTICE,
  PCC_TENDER_SEARCH_PATH,
  TENDER_SEARCH_CACHE_TTL_SECONDS,
  TENDER_SEARCH_MAX_RESULTS_RETURNED
} from "../constants.js";
import { registerEntry, type DatasetEntry } from "./index.js";

// --- pcc:searchbytitle: 依標案名稱搜尋政府採購公告 ---
//
// Source: g0v 社群維護的非官方鏡像, NOT an official agency API. See
// `SOURCE_PROVENANCE` in ./index.ts and the module comment in
// ../adapters/pcc.ts.
//
// Upstream search semantics, read directly off the implementation
// (`searchbytitleAction` in openfunltd/pcc.g0v.ronny.tw's
// webdata/controllers/ApiController.php) rather than inferred from the
// swagger summary:
//   - `query` is split on spaces; each token is wrapped in double quotes
//     and the tokens are combined with `default_operator: AND` against the
//     Elasticsearch `title` field. So it is an AND-of-phrases match on the
//     tender title, not a fuzzy or full-record search.
//   - Page size is a hardcoded 100, sorted `date desc`.
//
// **Deliberately NOT implemented: a 招標狀態 / tender-status parameter.**
// The task that added this entry suggested one, but no such parameter
// exists on this API — `/api/searchbytitle` accepts exactly `query`,
// `page`, and `columns[]`, verified in swagger.json. The nearest real
// thing is each record's own `brief.type` (公告類型, e.g. 招標公告 /
// 決標公告), which is returned as `announcementType` below and can be read
// per result. Inventing a status filter would have meant either silently
// ignoring it or faking it client-side over a single page of results.
//
// **Deliberately NOT implemented (yet): 預算金額 / 截止投標日期.** These are
// not in the base record. They'd have to come through the `columns[]`
// parameter, which takes raw field names out of each announcement's own
// stored blob (`機關資料:聯絡人`, `已公告資料:決標方式` are the only two
// examples the spec gives). The exact valid names vary by announcement type
// and are not enumerated anywhere in the repo, and this host is unreachable
// from the sandbox — so guessing them would be exactly the "憑記憶寫死"
// failure mode docs/ARCHITECTURE.md §1 warns about. They are left out until
// a production probe confirms the real names.

export interface TenderSearchParams {
  title: string;
  unitName?: string;
  page?: number;
}

/**
 * One search hit. Every field is nullable because this skeleton was built
 * against the service's OpenAPI spec rather than a captured real response
 * (the host is unreachable from this sandbox), so any given field may turn
 * out to be absent in practice — fail-soft per field is preferable to a
 * SCHEMA_MISMATCH that takes out an otherwise-usable result set.
 */
export interface TenderSummary {
  tenderName: string | null;
  unitName: string | null;
  unitId: string | null;
  /** 公告類型 (e.g. 招標公告 / 決標公告) — this API's only real status-like field. */
  announcementType: string | null;
  /** 標的分類. The spec explicitly notes this "may not necessarily appear in the response". */
  category: string | null;
  /** 公告日期, normalized from upstream's `YYYYMMDD` to `YYYY-MM-DD`. */
  announcedDate: string | null;
  jobNumber: string | null;
  /** 得標/相關廠商名稱, when the announcement carries any. */
  companies: string[];
  /** Human-browsable page for this announcement on the mirror. */
  detailUrl: string | null;
}

export interface TenderSearchResult {
  query: { title: string; unitName: string | null; page: number };
  /**
   * Source-credibility disclosure, carried in the DATA rather than only in
   * the tool description. See constants.ts's `PCC_SOURCE_NOTICE`.
   */
  sourceNotice: string;
  /** Verbatim 著作權聲明 governing reuse of this data. */
  copyrightNotice: readonly string[];
  /** Upstream's reported total match count, when it reports one. */
  totalRecords: number | null;
  returnedCount: number;
  /** True when upstream had more matches on this page than we return. */
  truncated: boolean;
  tenders: TenderSummary[];
}

interface PccBrief {
  type?: unknown;
  title?: unknown;
  category?: unknown;
  companies?: { ids?: unknown; names?: unknown } | null;
}

interface PccSearchRecord {
  date?: unknown;
  filename?: unknown;
  brief?: PccBrief | null;
  job_number?: unknown;
  unit_id?: unknown;
  unit_name?: unknown;
  url?: unknown;
}

export interface PccSearchResponse {
  query?: unknown;
  page?: unknown;
  total_records?: unknown;
  total_pages?: unknown;
  records?: unknown;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** `20230829` -> `2023-08-29`. Leaves anything not matching that shape untouched rather than guessing. */
export function formatAnnouncedDate(raw: unknown): string | null {
  const value = asStringOrNull(raw);
  if (value === null) return null;
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
}

/**
 * Re-applies the caller's filters locally, per AGENTS.md §6: upstream
 * filtering is never trusted to have actually happened.
 *
 * Two different reasons here, worth keeping distinct:
 * - `title` IS sent upstream (as `query`), so this is the §6 re-check —
 *   mirroring upstream's own AND-of-tokens semantics so a response that
 *   ignored the filter still gets narrowed correctly.
 * - `unitName` is NEVER sent upstream — this API has no agency-name search
 *   at all (`/api/listbyunit` needs a 機關代碼 like `3.76.53.97.30`, not a
 *   name). So for that field this isn't a re-check, it's the only filter
 *   there is, applied to `unit_name` which every search record carries.
 */
export function matchesTenderFilters(record: PccSearchRecord, params: TenderSearchParams): boolean {
  const title = asStringOrNull(record.brief?.title) ?? "";
  const unitName = asStringOrNull(record.unit_name) ?? "";

  const tokens = params.title.split(/\s+/).filter(t => t !== "");
  const titleMatches = tokens.every(token => title.toLowerCase().includes(token.toLowerCase()));
  if (!titleMatches) return false;

  if (params.unitName !== undefined && params.unitName.trim() !== "") {
    return unitName.toLowerCase().includes(params.unitName.trim().toLowerCase());
  }
  return true;
}

function toTenderSummary(record: PccSearchRecord): TenderSummary {
  const names = record.brief?.companies?.names;
  const relativeUrl = asStringOrNull(record.url);
  return {
    tenderName: asStringOrNull(record.brief?.title),
    unitName: asStringOrNull(record.unit_name),
    unitId: asStringOrNull(record.unit_id),
    announcementType: asStringOrNull(record.brief?.type),
    category: asStringOrNull(record.brief?.category),
    announcedDate: formatAnnouncedDate(record.date),
    jobNumber: asStringOrNull(record.job_number),
    companies: Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [],
    detailUrl: relativeUrl === null ? null : new URL(relativeUrl, PCC_SITE_BASE_URL).toString()
  };
}

export const tenderSearchInputShape = {
  title: z
    .string()
    .min(1)
    .describe("標案名稱關鍵字，例如「開放政府國家行動方案」。多個關鍵字以空格分隔，會以 AND 條件比對標案名稱（不是全文檢索，只比對標案名稱欄位）。"),
  unitName: z
    .string()
    .optional()
    .describe("選填，機關名稱關鍵字（部分比對，例如「臺北市政府」）。這是本伺服器在取得結果後自行篩選的，上游 API 不支援依機關名稱搜尋。"),
  page: z.number().int().min(1).max(100).optional().describe("選填，頁數，從 1 開始，預設 1。上游每頁固定 100 筆。")
};

export const tenderSearchEntry: DatasetEntry<TenderSearchParams, PccSearchResponse, TenderSearchResult> = {
  id: "pcc:searchbytitle",
  source: "pcc",
  path: PCC_TENDER_SEARCH_PATH,
  title: "政府採購標案搜尋（依標案名稱）",
  keywords: ["標案", "採購", "招標", "決標", "政府採購", "tender", "procurement"],
  paramsSchema: tenderSearchInputShape,
  buildQueryParams: params => ({
    query: params.title,
    page: params.page === undefined ? undefined : String(params.page)
  }),
  transform: (raw, params) => {
    const records = Array.isArray(raw?.records) ? (raw.records as PccSearchRecord[]) : [];
    const matched = records.filter(record => record !== null && typeof record === "object" && matchesTenderFilters(record, params));
    const returned = matched.slice(0, TENDER_SEARCH_MAX_RESULTS_RETURNED);

    return {
      query: {
        title: params.title,
        unitName: params.unitName ?? null,
        page: params.page ?? 1
      },
      sourceNotice: PCC_SOURCE_NOTICE,
      copyrightNotice: PCC_COPYRIGHT_NOTICE,
      totalRecords: typeof raw?.total_records === "number" ? raw.total_records : null,
      returnedCount: returned.length,
      truncated: matched.length > returned.length,
      tenders: returned.map(toTenderSummary)
    };
  },
  cacheTtlSeconds: TENDER_SEARCH_CACHE_TTL_SECONDS,
  updateFrequency: "依政府電子採購網公告時間，此鏡像另有重新擷取的延遲（非即時）",
  docUrl: `${PCC_SITE_BASE_URL}/`,
  notes:
    "非官方來源：g0v 社群維護的政府電子採購網鏡像。資料可能有延遲或缺漏，正式決標資訊以政府電子採購網為準。" +
    "此端點僅支援依標案名稱搜尋，不支援依招標狀態篩選；預算金額與截止投標日期不在此端點的回應中。",
  // No sampleParams: this host is unreachable from GitHub Actions (same as
  // `highway`), so scripts/fixtures/refresh-fixtures.ts would only ever
  // record a fetch failure for it. Left unset so the script skips it
  // outright rather than reporting a failure that is expected by design.
  fixtureFileName: "tender-search.json"
};

registerEntry(tenderSearchEntry as unknown as DatasetEntry<never, unknown, unknown>);
