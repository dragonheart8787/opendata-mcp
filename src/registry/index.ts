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
  source: "cwa" | "moenv";
  /** Dataset id/path used by the adapter to build the upstream URL. */
  path: string;
  title: string;
  keywords: string[];
  /** Zod raw shape — passed directly as an MCP tool's `inputSchema`. */
  paramsSchema: Record<string, ZodTypeAny>;
  buildQueryParams: (params: TParams) => Record<string, string | undefined>;
  transform: (raw: TRaw, params: TParams) => TResult;
  cacheTtlSeconds: number;
  /** Human-readable update cadence, surfaced in the response envelope (e.g. "每小時"). */
  updateFrequency: string;
  docUrl: string;
  notes?: string;
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
