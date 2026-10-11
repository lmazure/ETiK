import { MemoryError } from "./errors.js";

export const ROOT = "/";

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function invalid(path: string, reason: string): MemoryError {
  return new MemoryError("INVALID_PATH", `Invalid path '${path}': ${reason}`, { path });
}

/** Validates a document path: absolute, `/`-separated, no empty, `.` or `..` segment, no trailing `/`. */
export function normalizeDocPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) throw invalid(String(path), "empty path");
  if (!path.startsWith("/")) throw invalid(path, "paths are absolute and start with '/'");
  if (path === ROOT) throw invalid(path, "the root folder is not a document");
  if (path.length > MAX_PATH_LENGTH) throw invalid(path, `longer than ${MAX_PATH_LENGTH} characters`);
  if (CONTROL_CHARS.test(path)) throw invalid(path, "contains control characters");
  if (path.endsWith("/")) throw invalid(path, "a document path cannot end with '/'");
  for (const segment of path.slice(1).split("/")) {
    if (segment === "") throw invalid(path, "contains an empty segment ('//')");
    if (segment === "." || segment === "..") throw invalid(path, "'.' and '..' segments are not allowed");
    if (segment.length > MAX_SEGMENT_LENGTH) throw invalid(path, `a segment is longer than ${MAX_SEGMENT_LENGTH} characters`);
  }
  return path;
}

/** Validates a folder path; `/` is the root, a single trailing `/` is accepted and removed. */
export function normalizeFolderPath(path: string): string {
  if (path === ROOT) return ROOT;
  const trimmed = typeof path === "string" && path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return normalizeDocPath(trimmed);
}

/** True when `path` is strictly inside `folder`. */
export function isUnder(path: string, folder: string): boolean {
  return folder === ROOT ? path !== ROOT : path.startsWith(folder + "/");
}

/** `/a/b/c.md` → [`/a`, `/a/b`]. */
export function ancestorsOf(path: string): string[] {
  const segments = path.slice(1).split("/");
  const result: string[] = [];
  for (let i = 1; i < segments.length; i++) result.push("/" + segments.slice(0, i).join("/"));
  return result;
}

/** Rewrites `path` from below `fromFolder` to below `toFolder`. */
export function rebase(path: string, fromFolder: string, toFolder: string): string {
  const rest = fromFolder === ROOT ? path.slice(1) : path.slice(fromFolder.length + 1);
  return toFolder === ROOT ? "/" + rest : toFolder + "/" + rest;
}
