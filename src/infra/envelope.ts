import type { ToolError } from "./errors.js";

export interface SuccessEnvelope<TData> {
  [key: string]: unknown;
  ok: true;
  source: string;
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
