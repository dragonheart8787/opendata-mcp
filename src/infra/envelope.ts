import type { ToolError } from "./errors.js";

/**
 * Mirrors `SourceProvenance` in registry/index.ts. Duplicated as a literal
 * union rather than imported because `infra/` must not import from
 * `registry/` (AGENTS.md §1's layering rule); the two are kept in sync by
 * `test/infra/envelope.test.ts`, which asserts every provenance value the
 * registry can produce is assignable here.
 */
export type EnvelopeProvenance = "official" | "community-mirror" | "third-party-aggregator";

/**
 * Licence id treated as this server's default. A source under this licence
 * emits NO `licence` key at all, exactly like `provenance: "official"`
 * emits no `provenance` key — keeping every Taiwanese government source's
 * envelope byte-identical to what it produced before licensing was modelled
 * at all.
 *
 * Duplicated as a literal (not imported from `registry/`) for the same
 * layering reason as `EnvelopeProvenance`; `test/infra/envelope.test.ts`
 * asserts it still matches the registry's `OGDL_V1_LICENCE.id`.
 */
export const DEFAULT_ENVELOPE_LICENCE_ID = "ogdl-1.0";

/**
 * The reuse terms for the data in this envelope. Mirrors `SourceLicence` in
 * registry/index.ts (same layering-rule duplication as
 * `EnvelopeProvenance`).
 */
export interface EnvelopeLicence {
  id: string;
  name: string;
  url: string;
  commercialUseAllowed: boolean;
  attributionText: string;
}

export interface SuccessEnvelope<TData> {
  [key: string]: unknown;
  ok: true;
  source: string;
  /**
   * Whether `source` is the publishing agency itself or a third-party
   * republisher. **Only present when the source is NOT official** — every
   * source registered today is official, so this field is absent from
   * every response the server currently produces, leaving their shape
   * byte-identical to before this field existed. A caller treating
   * mirrored data as authoritative is the failure mode it exists to
   * prevent, so it appears exactly when that risk does.
   */
  provenance?: EnvelopeProvenance;
  /**
   * Reuse terms for this data. **Only present when the source is NOT under
   * this server's default licence** (政府資料開放授權條款第 1 版) — so every
   * Taiwanese government source's envelope is unchanged, and the key
   * appears exactly when a caller genuinely must not assume the default.
   *
   * A separate field from `provenance` on purpose: "who published this" and
   * "what may I do with it" are independent questions (see `SourceLicence`
   * in registry/index.ts).
   */
  licence?: EnvelopeLicence;
  dataset: string;
  /** Official "as of" timestamp for the data, when the upstream dataset provides one. */
  issuedAt?: string;
  fetchedAt: string;
  cached: boolean;
  updateFrequency: string;
  data: TData;
}

export interface FailureEnvelope {
  [key: string]: unknown;
  ok: false;
  error: {
    code: ToolError["code"];
    message: string;
    hint: string;
  };
}

export type Envelope<TData> = SuccessEnvelope<TData> | FailureEnvelope;

export interface BuildSuccessEnvelopeInput<TData> {
  source: string;
  /** Omit (or pass "official") for a government agency's own platform; set explicitly for anything republished by a third party. */
  provenance?: EnvelopeProvenance;
  /** Omit (or pass the OGDL v1 licence) for Taiwanese government sources; set explicitly for anything under different terms. */
  licence?: EnvelopeLicence;
  dataset: string;
  issuedAt?: string;
  cached: boolean;
  updateFrequency: string;
  data: TData;
}

export function buildSuccessEnvelope<TData>(input: BuildSuccessEnvelopeInput<TData>): SuccessEnvelope<TData> {
  return {
    ok: true,
    source: input.source,
    // Emitted ONLY for non-official sources. An unconditional new key on
    // every response would be a silent breaking change for anything
    // asserting on the envelope shape (the smoke test, connector clients,
    // this repo's own tests) — and would add noise to the ~2,000-token
    // response budget on every single call for no benefit while every
    // registered source is official.
    ...(input.provenance !== undefined && input.provenance !== "official" ? { provenance: input.provenance } : {}),
    // Same reasoning as `provenance` above, applied to licensing: emitted
    // only when the data is NOT under this server's default licence, so
    // every government source's envelope keeps its exact prior key set.
    ...(input.licence !== undefined && input.licence.id !== DEFAULT_ENVELOPE_LICENCE_ID ? { licence: input.licence } : {}),
    dataset: input.dataset,
    ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
    fetchedAt: new Date().toISOString(),
    cached: input.cached,
    updateFrequency: input.updateFrequency,
    data: input.data
  };
}

export function buildFailureEnvelope(error: ToolError): FailureEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      hint: error.hint
    }
  };
}
