import type { ToolError } from "./errors.js";

/**
 * Mirrors `SourceProvenance` in registry/index.ts. Duplicated as a literal
 * union rather than imported because `infra/` must not import from
 * `registry/` (see AGENTS.md §1's layering rule); the two are kept in sync
 * by `test/infra/envelope.test.ts`, which asserts the registry's own
 * provenance values are all assignable here.
 */
export type EnvelopeProvenance = "official" | "community-mirror";

export interface SuccessEnvelope<TData> {
  [key: string]: unknown;
  ok: true;
  source: string;
  /**
   * Whether `source` is the publishing agency itself or a third-party
   * republisher. Optional for backwards compatibility with the four
   * official sources that predate this field (absent means "official" —
   * see `buildSuccessEnvelope`), but always set explicitly for anything
   * that isn't a government agency's own platform, because a caller
   * treating mirrored data as authoritative is exactly the failure mode
   * this field exists to prevent.
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
  /** Omit for a government agency's own platform; set explicitly for anything republished by a third party. */
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
    // Only emitted when non-official, so the four pre-existing official
    // sources' response shape is byte-identical to before this field
    // existed — a new key appearing on every response would be a silent
    // breaking change for anything asserting on the envelope.
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
