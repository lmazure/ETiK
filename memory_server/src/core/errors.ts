export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "IS_FOLDER"
  | "VERSION_CONFLICT"
  | "APPEND_ONLY"
  | "NOT_UNIQUE"
  | "NO_MATCH"
  | "SECTION_NOT_FOUND"
  | "SECTION_AMBIGUOUS"
  | "UNSUPPORTED"
  | "FORBIDDEN"
  | "TOO_LARGE";

/**
 * Error raised by the core. The message is meant to be shown as is to a model or a person:
 * it says what failed, where, and what to do. `details` carries the same facts in structured form.
 */
export class MemoryError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MemoryError";
  }
}
