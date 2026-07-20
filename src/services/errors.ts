/**
 * Shared error type for upstream open-data API failures. The `.message` is
 * written to be shown directly to an LLM/user and always says what to do
 * next (apply for a key, fix a parameter, retry later, ...).
 */
export class OpenDataApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenDataApiError";
  }
}
