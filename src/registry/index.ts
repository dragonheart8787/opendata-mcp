import type { ZodTypeAny } from "zod";

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
  source: "cwa" | "moenv" | "tdx";
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
