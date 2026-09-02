import type { ZodTypeAny } from "zod";

import {
  OPEN_METEO_ATTRIBUTION,
  OPEN_METEO_LICENCE_ID,
  OPEN_METEO_LICENCE_NAME,
  OPEN_METEO_LICENCE_URL
} from "../constants.js";

/** Every upstream this server can talk to. Adding one means adding an adapter with the same id. */
export type SourceId = "cwa" | "moenv" | "tdx" | "highway" | "openmeteo";

/**
 * Whether a source is the agency publishing its own data, or a third party
 * republishing someone else's.
 *
 * - `official`: a government agency's own platform. The agency is both the
 *   data's author and its publisher, and its response is authoritative.
 * - `community-mirror`: a volunteer/community-run service that re-publishes
 *   an agency's data. Useful (often far more queryable than the official
 *   site), but it is a *copy*: it can lag, drop records, or go stale
 *   without the originating agency knowing or caring, and nothing about it
 *   is binding for any official purpose.
 * - `third-party-aggregator`: a professionally-run service that ingests
 *   multiple upstream authorities' data and *derives* new values from it
 *   (interpolating model grids, harmonizing units, filling gaps). Unlike a
 *   mirror it is not claiming to reproduce any one agency's output
 *   verbatim, so a value it returns may not appear in ANY official
 *   publication — which is exactly why it can't be labelled `official`,
 *   and equally why "mirror" would understate what it does. Open-Meteo
 *   (`openmeteo`) is the first: it serves interpolated output from DWD
 *   ICON, NOAA HRRR, Météo-France AROME and others.
 *
 * `community-mirror` still has no registered user — it is kept because the
 * distinction has to be *carryable* the moment such a source is added: the
 * response envelope and `tw_search_datasets` both consume this (see
 * infra/envelope.ts's `provenance` and tools/generic.ts). See AGENTS.md §6
 * for the mirror that prompted it and why it isn't registered.
 */
export type SourceProvenance = "official" | "community-mirror" | "third-party-aggregator";

/**
 * The authoritative source-to-provenance mapping. Lives here (not on the
 * adapter) so the registry and the generic tools can classify an entry
 * without importing the adapter layer — `adapters/` imports from
 * `registry/`, so the reverse would be circular.
 */
export const SOURCE_PROVENANCE: Record<SourceId, SourceProvenance> = {
  cwa: "official",
  moenv: "official",
  tdx: "official",
  highway: "official",
  openmeteo: "third-party-aggregator"
};

export function getSourceProvenance(source: SourceId): SourceProvenance {
  return SOURCE_PROVENANCE[source];
}

export function isOfficialSource(source: SourceId): boolean {
  return SOURCE_PROVENANCE[source] === "official";
}

/**
 * The terms a source's DATA may be reused under.
 *
 * **This is deliberately a separate axis from `SourceProvenance`, not more
 * values bolted onto it.** Provenance answers "how much authority does this
 * carry" (is it the agency itself, a copy, or a derived product);
 * `SourceLicence` answers "what am I allowed to do with it". The two are
 * genuinely orthogonal — an official agency's data can be CC BY, and a
 * non-official aggregator's can be public domain — so folding a licence
 * into the provenance union (e.g. a `"cc-by-noncommercial"` member) would
 * force one field to mean two unrelated things and make combinations that
 * really occur inexpressible. Adding this alongside, rather than widening
 * the existing enum, is the answer to "can SourceProvenance be extended to
 * cover licensing" — the enum WAS extended (`third-party-aggregator`), but
 * only for the part of Open-Meteo that is genuinely a provenance fact.
 */
export interface SourceLicence {
  /** Stable machine id, e.g. "ogdl-1.0", "cc-by-4.0". */
  id: string;
  /** Human-readable name, surfaced to callers. */
  name: string;
  /** Canonical licence text URL. */
  url: string;
  /**
   * Whether the licence permits commercial reuse. 政府資料開放授權條款第 1 版
   * does; Open-Meteo's free tier explicitly does not (its terms restrict the
   * free API to non-commercial use and direct commercial users to a paid
   * plan), which is a real, caller-visible constraint and not merely
   * paperwork.
   */
  commercialUseAllowed: boolean;
  /**
   * Attribution/notice text a caller must carry when redistributing. Non-
   * empty for licences that make attribution a condition (CC BY); the
   * curated tool also embeds this in its response DATA — see
   * `OPEN_METEO_ATTRIBUTION` in constants.ts for why description-only
   * placement is not sufficient.
   */
  attributionText: string;
}

/**
 * 政府資料開放授權條款第 1 版 — the licence every Taiwanese government source
 * in this server publishes under, and this project's default (see
 * docs/ARCHITECTURE.md §4.4 and the README's licence section).
 */
export const OGDL_V1_LICENCE: SourceLicence = {
  id: "ogdl-1.0",
  name: "政府資料開放授權條款第 1 版",
  url: "https://data.gov.tw/license",
  commercialUseAllowed: true,
  attributionText: ""
};

export const CC_BY_4_0_LICENCE: SourceLicence = {
  id: OPEN_METEO_LICENCE_ID,
  name: OPEN_METEO_LICENCE_NAME,
  url: OPEN_METEO_LICENCE_URL,
  commercialUseAllowed: false,
  attributionText: OPEN_METEO_ATTRIBUTION
};

export const SOURCE_LICENCE: Record<SourceId, SourceLicence> = {
  cwa: OGDL_V1_LICENCE,
  moenv: OGDL_V1_LICENCE,
  tdx: OGDL_V1_LICENCE,
  highway: OGDL_V1_LICENCE,
  openmeteo: CC_BY_4_0_LICENCE
};

export function getSourceLicence(source: SourceId): SourceLicence {
  return SOURCE_LICENCE[source];
}

/**
 * A dataset registered with the server: everything needed to expose it
 * through a tool without that tool knowing anything about the upstream API.
 *
 * This extends the architecture doc's draft `DatasetEntry` type (which the
 * doc itself describes as containing "at least" these fields) with two
 * additional fields required to actually preserve existing tool behavior:
 *
 * - `buildQueryParams`: the doc's `SourceAdapter.fetchDataset` builds the
 *   upstream URL, but *which* upstream query param names/values correspond
 *   to our tool's params is dataset-specific (CWA's weather forecast wants
 *   `locationName`, not `city`; MOENV's air quality wants a
 *   `filters=field,EQ,value` string). The adapter has no way to know this
 *   generically, so each entry supplies the mapping.
 * - `transform`'s signature is `(raw, params) => result`, not the draft's
 *   `(raw) => result`. Filtering by the caller's params (which county,
 *   which station, how many earthquakes) is explicitly transform's job per
 *   the doc ("篩選是 transform 的責任"), which is impossible without access
 *   to the params that were filtered by.
 *
 * Both are disclosed in the PR that introduced this layer.
 */
export interface DatasetEntry<TParams = never, TRaw = unknown, TResult = unknown> {
  /** e.g. "cwa:F-C0032-001" */
  id: string;
  source: SourceId;
  /** Dataset id/path used by the adapter to build the upstream URL. */
  path: string;
  title: string;
  keywords: string[];
  /** Zod raw shape — passed directly as an MCP tool's `inputSchema`. */
  paramsSchema: Record<string, ZodTypeAny>;
  /**
   * Optional cross-field validation `paramsSchema` alone can't express —
   * e.g. air quality's "exactly one of county/siteName", which is a
   * relationship between two otherwise-independently-optional fields, not
   * a per-field constraint. Called (if present) after `paramsSchema`
   * validation succeeds and before `buildQueryParams`/fetch, by both the
   * curated tool and `tw_query_dataset` (tools/generic.ts) — the single
   * place this rule needs to live so the two paths can't drift apart.
   * Should throw a `ToolError` (typically `INVALID_PARAMS`) on violation.
   */
  validateParams?: (params: TParams) => void;
  buildQueryParams: (params: TParams) => Record<string, string | undefined>;
  /**
   * Optional additional URL path segments to append after `path`, computed
   * from params. Needed by TDX: its REST paths embed the primary selector
   * as a path segment rather than a query parameter (e.g.
   * `Bus/EstimatedTimeOfArrival/City/{city}`), unlike CWA/MOENV which
   * always use a fixed dataset `path` plus query-string params for
   * everything variable. Each returned segment is URL-encoded individually
   * by the adapter (`adapters/tdx.ts`'s `buildTdxUrl`). Undefined/omitted
   * for CWA/MOENV entries, which don't need it — a third extension beyond
   * the two already disclosed above (`validateParams`, `buildQueryParams`
   * taking `(raw, params)`), added and disclosed in the PR that introduced
   * the TDX adapter.
   */
  buildPathSegments?: (params: TParams) => string[];
  transform: (raw: TRaw, params: TParams) => TResult;
  cacheTtlSeconds: number;
  /** Human-readable update cadence, surfaced in the response envelope (e.g. "每小時"). */
  updateFrequency: string;
  docUrl: string;
  notes?: string;
  /**
   * A realistic, valid params object used only by
   * scripts/fixtures/refresh-fixtures.ts to exercise this entry against the
   * real upstream API. Optional — there's no generic, safe way to guess
   * valid params for an arbitrary dataset (a required enum field needs a
   * real member value, not just "any string"), so an entry without this
   * set is skipped by refresh-fixtures.ts (logged, not fatal) rather than
   * the script crashing or sending a bogus request.
   */
  sampleParams?: TParams;
  /**
   * Fixture filename (relative to test/fixtures/), used by
   * scripts/fixtures/refresh-fixtures.ts and read directly by this entry's
   * own tests. Optional — refresh-fixtures.ts falls back to a name derived
   * from `id` if omitted, but that fallback won't match what an existing
   * test file reads, so any entry with committed tests should set this
   * explicitly.
   */
  fixtureFileName?: string;
}

const registry = new Map<string, DatasetEntry<never, unknown, unknown>>();

export function registerEntry(entry: DatasetEntry<never, unknown, unknown>): void {
  if (registry.has(entry.id)) {
    throw new Error(`Duplicate dataset entry id: ${entry.id}`);
  }
  registry.set(entry.id, entry);
}

export function getDatasetEntry<TParams = never, TRaw = unknown, TResult = unknown>(
  id: string
): DatasetEntry<TParams, TRaw, TResult> {
  const entry = registry.get(id);
  if (!entry) {
    throw new Error(`Unknown dataset entry id: ${id}`);
  }
  return entry as unknown as DatasetEntry<TParams, TRaw, TResult>;
}

export function listDatasetEntries(): DatasetEntry<never, unknown, unknown>[] {
  return [...registry.values()];
}
