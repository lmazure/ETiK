export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_REFERENCE"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "GITLAB_ERROR"
  | "GITLAB_UNAVAILABLE"
  | "REPO_ERROR"
  | "MEMORY_ERROR"
  | "NOT_CONFIGURED"
  | "ANALYSIS_FAILED";

/**
 * Error raised while serving a tool. The message is meant to be shown as is to a model or a person:
 * it says what failed and what to do.
 */
export class AnalystError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AnalystError";
  }
}
