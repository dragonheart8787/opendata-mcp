import type { ToolError } from "./errors.js";

/**
 * Mirrors `SourceProvenance` in registry/index.ts. Duplicated as a literal
 * union rather than imported because `infra/` must not import from
 * `registry/` (AGENTS.md §1's layering rule); the two are kept in sync by
 * `test/infra/envelope.test.ts`, which asserts every provenance value the
 * registry can produce is assignable here.
 */
export type EnvelopeProvenance = "official" | "community-mirror";

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
