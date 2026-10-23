/**
 * GitLab references given by callers. Parsing them is the only way an input becomes part of an API path:
 * the server never fetches a URL it is given, it extracts a namespace path and an iid from it.
 */
import { AnalystError } from "../errors.js";

export type RefKind = "work_item" | "merge_request";

export interface Ref {
  kind: RefKind;
  /** Full path of the project or group, e.g. `henixdevelopment/squash/squash-tm/core/squashtest-tm-staging`. */
  path: string;
  iid: number;
}

export interface RefContext {
  gitlabUrl: string;
  defaultProject: string;
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const MAX_IID = 2 ** 31 - 1;

export function isNamespacePath(path: string): boolean {
  const segments = path.split("/");
  return segments.length <= 20 && segments.every((s) => SEGMENT.test(s) && !s.endsWith(".git") && !s.includes(".."));
}

function iidOf(raw: string, input: string): number {
  const iid = Number(raw);
  if (!Number.isInteger(iid) || iid < 1 || iid > MAX_IID) throw invalid(input);
  return iid;
}

function invalid(input: string, why = ""): AnalystError {
  return new AnalystError("INVALID_REFERENCE",
    `'${input}' is not a GitLab reference${why}. Give a GitLab URL, 'group/project#123' (work item), 'group/project!123' (merge request), '#123', '!123' or '123'.`);
}

function checked(ref: Ref, expected: RefKind, input: string): Ref {
  if (!isNamespacePath(ref.path)) throw invalid(input, " (invalid project or group path)");
  if (ref.kind !== expected) {
    throw new AnalystError("INVALID_REFERENCE", ref.kind === "merge_request"
      ? `'${input}' is a merge request: use gitlab_merge_request.`
      : `'${input}' is a work item: use gitlab_work_item.`);
  }
  return ref;
}

/** Parses a URL of the GitLab instance: work item, issue, epic or merge request pages (sub-pages such as /diffs too). */
function parseUrl(input: string, context: RefContext): Ref {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid(input);
  }
  if (url.origin !== context.gitlabUrl) throw invalid(input, ` (only ${context.gitlabUrl} is served)`);
  const match = /^\/(?:groups\/)?(.+?)\/-\/(work_items|issues|epics|merge_requests)\/(\d+)(?:\/.*)?$/.exec(decodeURIComponent(url.pathname));
  if (!match) throw invalid(input);
  return { kind: match[2] === "merge_requests" ? "merge_request" : "work_item", path: match[1]!, iid: iidOf(match[3]!, input) };
}

/**
 * Parses a reference expected to be of `expected` kind. A bare number is of that kind, in the default project;
 * `#n` and `path#n` (or `path&n`, an epic) are work items, `!n` and `path!n` merge requests.
 */
export function parseRef(raw: string, expected: RefKind, context: RefContext): Ref {
  const input = raw.trim();
  if (/^https?:\/\//i.test(input)) return checked(parseUrl(input, context), expected, input);
  const bare = /^(\d+)$/.exec(input);
  if (bare) return checked({ kind: expected, path: context.defaultProject, iid: iidOf(bare[1]!, input) }, expected, input);
  const short = /^([^#!&\s]*)([#!&])(\d+)$/.exec(input);
  if (!short) throw invalid(input);
  const path = short[1] === "" ? context.defaultProject : short[1]!;
  if (short[2] === "&" && short[1] === "") throw invalid(input, " (an epic needs its group: 'group&123')");
  return checked({ kind: short[2] === "!" ? "merge_request" : "work_item", path, iid: iidOf(short[3]!, input) }, expected, input);
}

/** Display form: `#123` / `!123` in the default project, `path#123` / `path!123` elsewhere. */
export function formatRef(ref: Ref, defaultProject: string): string {
  const sigil = ref.kind === "merge_request" ? "!" : "#";
  return `${ref.path === defaultProject ? "" : ref.path}${sigil}${ref.iid}`;
}
