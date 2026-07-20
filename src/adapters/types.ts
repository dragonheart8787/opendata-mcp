import type { Env } from "../index.js";
import type { DatasetEntry } from "../registry/index.js";

/**
 * One module per upstream data source. `fetchDataset` owns everything
 * source-specific about getting data onto the wire and back: auth
 * injection, URL assembly (via the entry's `buildQueryParams`), timeout +
 * retry (via infra/http.ts), and normalizing the response into "raw JSON"
 * — unwrapping whatever envelope/quirk the source itself uses (CWA's
 * `{success, records}`, MOENV's bare array + "", "-", "ND" missing-value
 * markers) — without doing any dataset-specific filtering, which is
 * transform's job (see registry/index.ts's DatasetEntry doc comment).
 *
 * `fetchImpl` is an addition beyond the architecture doc's 3-argument
 * draft signature (`entry, params, env`): purely a dependency-injection
 * seam for tests (defaults to the global `fetch`), not a behavioral
 * addition — same pattern the pre-refactor CWA/MOENV clients already used.
 */
export interface SourceAdapter {
  id: "cwa" | "moenv";
  displayName: string;
  fetchDataset<TParams, TRaw>(
    entry: DatasetEntry<TParams, TRaw, unknown>,
    params: TParams,
    env: Env,
    fetchImpl?: typeof fetch
  ): Promise<TRaw>;
}
