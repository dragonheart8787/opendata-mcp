/**
 * Unified error type for the whole fetch -> transform pipeline (adapters,
 * registry transforms, and the tool wrappers all throw this). Replaces the
 * old `OpenDataApiError` / `CwaApiError` pair from before the layered
 * refactor — one error type, one envelope shape (see infra/envelope.ts).
 */
export type ToolErrorCode =
  | "UPSTREAM_TIMEOUT"
  | "INVALID_PARAMS"
  | "AUTH_MISSING"
  | "UPSTREAM_ERROR"
  | "SCHEMA_MISMATCH"
  | "NOT_FOUND";

export interface ToolErrorInit {
  code: ToolErrorCode;
  message: string;
  /**
   * A concrete, actionable next step. Every existing error message already
   * *contains* its own actionable suggestion inline (apply for a key at
   * this URL, fix this parameter, retry later, ...), so for messages
   * carried over from before the refactor `hint` currently just mirrors
   * `message` rather than being a separately-authored short string — the
   * content itself hasn't changed, only where it's exposed from. Splitting
   * these into a genuinely distinct short `hint` is worth doing later, but
   * out of scope for this session (pure behavior-preserving layering).
   */
  hint?: string;
}

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly hint: string;

  constructor(init: ToolErrorInit) {
    super(init.message);
    this.name = "ToolError";
    this.code = init.code;
    this.hint = init.hint ?? init.message;
  }
}

/** Normalizes any thrown value into a ToolError, for the outermost catch in each tool wrapper. */
export function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }
  return new ToolError({
    code: "UPSTREAM_ERROR",
    message: `發生未預期的錯誤：${error instanceof Error ? error.message : String(error)}`
  });
}
