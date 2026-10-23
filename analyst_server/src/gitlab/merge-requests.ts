/** A merge request with its diff, pipeline and discussions, read through the REST API. */
import { encodePath, type GitLabClient } from "./client.js";
import { parseRef, type Ref, type RefContext } from "./refs.js";

export interface FileChange {
  oldPath: string;
  newPath: string;
  status: "added" | "deleted" | "renamed" | "modified";
  added: number;
  removed: number;
  diff: string;
  /** GitLab did not return the diff of this file (too large or collapsed). */
  diffMissing: boolean;
}

export interface Discussion {
  resolved: boolean | undefined;
  notes: { author: string; createdAt: string; body: string; position: string | undefined }[];
}

export interface MergeRequest {
  ref: Ref;
  title: string;
  state: string;
  draft: boolean;
  url: string;
  author: string | undefined;
  createdAt: string;
  sourceBranch: string;
  targetBranch: string;
  mergedBy: string | undefined;
  mergedAt: string | undefined;
  mergeCommitSha: string | undefined;
  squashCommitSha: string | undefined;
  labels: string[];
  description: string;
  closesIssues: { ref: Ref; title: string; state: string; url: string }[];
  files: FileChange[];
  /** More files than read (the diff stops at MAX_DIFF_PAGES pages). */
  filesTruncated: boolean;
  pipeline: { status: string; url: string; failedJobs: { name: string; stage: string; url: string }[] } | undefined;
  discussions: Discussion[];
}

interface RawUser { username: string }
interface RawMergeRequest {
  title: string;
  state: string;
  draft?: boolean;
  web_url: string;
  author: RawUser | null;
  created_at: string;
  source_branch: string;
  target_branch: string;
  merged_by?: RawUser | null;
  merge_user?: RawUser | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  squash_commit_sha: string | null;
  labels: string[];
  description: string | null;
  head_pipeline?: { id: number; status: string; web_url: string; project_id: number } | null;
}
interface RawDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  too_large?: boolean;
  collapsed?: boolean;
}
interface RawIssue { title: string; state: string; web_url: string }
interface RawJob { name: string; stage: string; web_url: string }
interface RawDiscussion {
  individual_note: boolean;
  notes: { body: string; system: boolean; created_at: string; author: RawUser | null; resolvable: boolean; resolved?: boolean; position?: { new_path?: string; new_line?: number | null; old_line?: number | null } }[];
}

const PER_PAGE = 100;
const MAX_DIFF_PAGES = 5;

/** Number of added and removed lines of a unified diff. */
export function countLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function fileStatus(d: RawDiff): FileChange["status"] {
  if (d.new_file) return "added";
  if (d.deleted_file) return "deleted";
  if (d.renamed_file) return "renamed";
  return "modified";
}

export class MergeRequests {
  constructor(
    private readonly gitlab: GitLabClient,
    private readonly context: RefContext,
  ) {}

  async get(ref: Ref, includeDiff: boolean): Promise<MergeRequest> {
    const base = `/projects/${encodePath(ref.path)}/merge_requests/${ref.iid}`;
    const raw = await this.gitlab.rest<RawMergeRequest>(base);
    const [closes, diffs, discussions, failedJobs] = await Promise.all([
      this.gitlab.rest<RawIssue[]>(`${base}/closes_issues`, { per_page: PER_PAGE }),
      this.diffs(base, includeDiff),
      this.gitlab.rest<RawDiscussion[]>(`${base}/discussions`, { per_page: PER_PAGE }),
      raw.head_pipeline && raw.head_pipeline.status === "failed"
        ? this.gitlab.rest<RawJob[]>(`/projects/${raw.head_pipeline.project_id}/pipelines/${raw.head_pipeline.id}/jobs`, { "scope[]": "failed", per_page: PER_PAGE })
        : Promise.resolve([]),
    ]);
    return {
      ref,
      title: raw.title,
      state: raw.state,
      draft: raw.draft ?? false,
      url: raw.web_url,
      author: raw.author?.username,
      createdAt: raw.created_at,
      sourceBranch: raw.source_branch,
      targetBranch: raw.target_branch,
      mergedBy: (raw.merge_user ?? raw.merged_by)?.username,
      mergedAt: raw.merged_at ?? undefined,
      mergeCommitSha: raw.merge_commit_sha ?? undefined,
      squashCommitSha: raw.squash_commit_sha ?? undefined,
      labels: raw.labels,
      description: raw.description ?? "",
      closesIssues: closes.map((i) => ({ ref: parseRef(i.web_url, "work_item", this.context), title: i.title, state: i.state, url: i.web_url })),
      files: diffs.files,
      filesTruncated: diffs.truncated,
      pipeline: raw.head_pipeline
        ? { status: raw.head_pipeline.status, url: raw.head_pipeline.web_url, failedJobs: failedJobs.map((j) => ({ name: j.name, stage: j.stage, url: j.web_url })) }
        : undefined,
      discussions: discussions
        .map((d) => ({ d, notes: d.notes.filter((n) => !n.system) }))
        .filter(({ notes }) => notes.length > 0)
        .map(({ notes }) => ({
          resolved: notes[0]!.resolvable ? notes.every((n) => !n.resolvable || n.resolved === true) : undefined,
          notes: notes.map((n) => ({
            author: n.author?.username ?? "unknown",
            createdAt: n.created_at,
            body: n.body,
            position: n.position?.new_path ? `${n.position.new_path}:${n.position.new_line ?? n.position.old_line ?? "?"}` : undefined,
          })),
        })),
    };
  }

  /** The changed files, with their diff when asked; at most MAX_DIFF_PAGES pages of files. */
  private async diffs(base: string, includeDiff: boolean): Promise<{ files: FileChange[]; truncated: boolean }> {
    const files: FileChange[] = [];
    for (let page = 1; page <= MAX_DIFF_PAGES; page++) {
      const batch = await this.gitlab.rest<RawDiff[]>(`${base}/diffs`, { per_page: PER_PAGE, page });
      for (const d of batch) {
        files.push({
          oldPath: d.old_path,
          newPath: d.new_path,
          status: fileStatus(d),
          ...countLines(d.diff),
          diff: includeDiff ? d.diff : "",
          diffMissing: d.diff === "" && (d.too_large === true || d.collapsed === true),
        });
      }
      if (batch.length < PER_PAGE) return { files, truncated: false };
    }
    return { files, truncated: true };
  }
}
