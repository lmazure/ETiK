/**
 * Text results for the model: one line per item, sections in Markdown, explicit truncation, actionable errors.
 * See the "Tools" section of the README.
 */
import type { Job } from "../engine/jobs.js";
import { AnalystError } from "../errors.js";
import type { FileChange, MergeRequest } from "../gitlab/merge-requests.js";
import { formatRef, type Ref } from "../gitlab/refs.js";
import type { SearchHit } from "../gitlab/search.js";
import type { ItemSummary, MergeRequestSummary, WorkItem } from "../gitlab/work-items.js";

/** Longest comment of a work item, and longest note of a merge request discussion (bot reviews can be huge). */
const MAX_COMMENT_CHARS = 4_000;
const MAX_NOTE_CHARS = 2_000;

function cut(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}\n(cut: ${trimmed.length - maxChars} more characters)`;
}

function plural(n: number, word: string, words = word + "s"): string {
  return `${n} ${n === 1 ? word : words}`;
}

/** Cuts a result to `maxChars`, saying so. */
export function bounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const notice = `\n\n[truncated: ${text.length - maxChars} more characters not shown]`;
  return text.slice(0, Math.max(0, maxChars - notice.length)) + notice;
}

function labelValue(labels: string[], scope: string): string | undefined {
  const label = labels.find((l) => l.startsWith(`${scope}::`));
  return label?.slice(scope.length + 2);
}

/** The label `Type::X` says what a work item is (user story, bug…) better than its GitLab type. */
function kindOf(item: ItemSummary): string {
  return labelValue(item.labels, "Type") ?? item.type;
}

function countStates(states: string[]): string {
  const counts = new Map<string, number>();
  for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].map(([s, n]) => (n === 1 ? s : `${s} ×${n}`)).join(", ");
}

export class Formatter {
  constructor(private readonly defaultProject: string) {}

  private ref(ref: Ref): string {
    return formatRef(ref, this.defaultProject);
  }

  private itemLine(item: ItemSummary): string {
    const status = labelValue(item.labels, "Status");
    return [
      this.ref(item.ref), kindOf(item), item.state.toLowerCase(), item.title,
      status ? `Status::${status}` : "",
      item.mergeRequestStates === undefined ? "MRs: not read" : item.mergeRequestStates.length ? `MRs: ${countStates(item.mergeRequestStates)}` : "",
      item.url,
    ].filter((s) => s !== "").join(" · ");
  }

  private mergeRequestLine(mr: MergeRequestSummary): string {
    return [
      this.ref(mr.ref), mr.state.toLowerCase(), mr.title,
      mr.sourceBranch ? `${mr.sourceBranch} → ${mr.targetBranch}` : "",
      mr.mergedAt ? `merged ${mr.mergedAt}` : "",
      mr.mergeCommitSha ? `merge commit ${mr.mergeCommitSha}` : "",
      mr.pipelineStatus ? `pipeline ${mr.pipelineStatus.toLowerCase()}` : "",
      mr.url,
    ].filter((s) => s !== "").join(" · ");
  }

  workItem(item: WorkItem): string {
    const out = [
      `${this.ref(item.ref)} · ${kindOf(item)}${kindOf(item) === item.type ? "" : ` (${item.type})`} · ${item.state.toLowerCase()} · ${item.title}`,
      `url: ${item.url}`,
    ];
    const facts = [
      item.status ? `status: ${item.status}` : "",
      item.milestone ? `milestone: ${item.milestone}` : "",
      item.assignees.length ? `assignees: ${item.assignees.join(", ")}` : "",
      item.author ? `author: ${item.author}` : "",
    ].filter((s) => s !== "");
    if (facts.length) out.push(facts.join(" · "));
    out.push(["created: " + item.createdAt, item.closedAt ? `closed: ${item.closedAt}` : "", `updated: ${item.updatedAt}`].filter((s) => s !== "").join(" · "));
    if (item.labels.length) out.push(`labels: ${item.labels.join(", ")}`);
    const weights = [item.weight !== undefined ? `weight: ${item.weight}` : "", ...item.customFields.map((f) => `${f.name}: ${f.value}`)].filter((s) => s !== "");
    if (weights.length) out.push(weights.join(" · "));

    out.push("", "## Description", "", item.description.trim() || "(no description)");

    out.push("", "## Hierarchy", "");
    item.ancestors.forEach((a, depth) => out.push(`${"  ".repeat(depth)}${this.itemLine(a)}`));
    const depth = item.ancestors.length;
    const indent = "  ".repeat(depth);
    if (depth === 0) out.push("(no parent)");
    out.push(`${indent}▶ ${this.ref(item.ref)} (this work item)`);
    for (const child of item.children) out.push(`${indent}  ${this.itemLine(child)}`);
    if (item.children.length === 0) out.push(`${indent}  (no children)`);
    if (item.siblings.length) out.push(`${indent}siblings (the other children of the parent):`);
    for (const sibling of item.siblings) out.push(`${indent}${this.itemLine(sibling)}`);

    if (item.linkedItems.length) {
      out.push("", `## Linked items (${item.linkedItems.length})`, "");
      for (const link of item.linkedItems) out.push(`- ${link.linkType.toLowerCase()}: ${this.itemLine(link.item)}`);
    }

    out.push("", `## Merge requests (${item.mergeRequests.length})`, "");
    if (item.mergeRequests.length === 0) out.push("(none)");
    for (const mr of item.mergeRequests) out.push(`- ${this.mergeRequestLine(mr)}`);

    out.push("", item.comments.length === item.commentsTotal
      ? `## Comments (${item.commentsTotal}, oldest first)`
      : `## Comments (the last ${item.comments.length} of ${item.commentsTotal}, oldest first)`);
    if (item.commentsTotal === 0) out.push("", "(none)");
    for (const c of item.comments) out.push("", `### ${c.author} · ${c.createdAt}`, "", cut(c.body, MAX_COMMENT_CHARS));
    return out.join("\n");
  }

  mergeRequest(mr: MergeRequest, maxDiffChars: number, includeDiff: boolean): string {
    const out = [
      `${this.ref(mr.ref)} · ${mr.draft ? "draft · " : ""}${mr.state} · ${mr.title}`,
      `url: ${mr.url}`,
      [mr.author ? `author: ${mr.author}` : "", `created: ${mr.createdAt}`].filter((s) => s !== "").join(" · "),
      `branches: ${mr.sourceBranch} → ${mr.targetBranch}`,
    ];
    const merge = [
      mr.mergedAt ? `merged ${mr.mergedAt}${mr.mergedBy ? ` by ${mr.mergedBy}` : ""}` : "",
      mr.mergeCommitSha ? `merge commit ${mr.mergeCommitSha}` : "",
      mr.squashCommitSha ? `squash commit ${mr.squashCommitSha}` : "",
    ].filter((s) => s !== "");
    if (merge.length) out.push(merge.join(" · "));
    if (mr.labels.length) out.push(`labels: ${mr.labels.join(", ")}`);
    for (const issue of mr.closesIssues) out.push(`closes: ${this.ref(issue.ref)} · ${issue.state} · ${issue.title} · ${issue.url}`);
    if (mr.pipeline) {
      out.push(`pipeline: ${mr.pipeline.status} · ${mr.pipeline.url}`);
      for (const job of mr.pipeline.failedJobs) out.push(`  failed job: ${job.name} (${job.stage}) · ${job.url}`);
    } else {
      out.push("pipeline: none");
    }

    out.push("", "## Description", "", mr.description.trim() || "(no description)");

    const added = mr.files.reduce((n, f) => n + f.added, 0);
    const removed = mr.files.reduce((n, f) => n + f.removed, 0);
    out.push("", `## Changed files (${mr.files.length}${mr.filesTruncated ? "+, the rest not read" : ""}, +${added} −${removed})`, "");
    for (const f of mr.files) out.push(`- ${f.status} ${f.status === "renamed" ? `${f.oldPath} → ${f.newPath}` : f.newPath} (+${f.added} −${f.removed})`);

    if (includeDiff) {
      out.push("", "## Diff");
      out.push(...this.diffs(mr.files, maxDiffChars));
    }

    out.push("", `## Discussions (${mr.discussions.length})`);
    if (mr.discussions.length === 0) out.push("", "(none)");
    for (const d of mr.discussions) {
      const [first, ...replies] = d.notes;
      if (!first) continue;
      const state = d.resolved === undefined ? "" : d.resolved ? "[resolved] " : "[unresolved] ";
      out.push("", `### ${state}${first.author} · ${first.createdAt}${first.position ? ` · ${first.position}` : ""}`, "", cut(first.body, MAX_NOTE_CHARS));
      for (const r of replies) out.push("", `↳ ${r.author} · ${r.createdAt}: ${cut(r.body, MAX_NOTE_CHARS)}`);
    }
    return out.join("\n");
  }

  /** Each file gets an equal share of what is left of the budget; what a small file does not use goes to the next ones. */
  private diffs(files: FileChange[], maxChars: number): string[] {
    const out: string[] = [];
    let budget = maxChars;
    files.forEach((f, index) => {
      out.push("", `### ${f.newPath}`);
      if (f.diffMissing) {
        out.push("(diff not returned by GitLab: too large)");
        return;
      }
      if (f.diff === "") {
        out.push("(no textual change)");
        return;
      }
      const share = Math.floor(budget / (files.length - index));
      const shown = f.diff.length <= share ? f.diff : f.diff.slice(0, share);
      budget -= shown.length;
      out.push("```diff", shown.replace(/\n$/, ""), "```");
      if (shown.length < f.diff.length) out.push(`(cut: ${f.diff.length - shown.length} more characters of this file's diff; raise max_diff_chars to see more)`);
    });
    return out;
  }

  search(query: string, kind: "work_item" | "merge_request", scope: string, hits: SearchHit[]): string {
    const what = kind === "work_item" ? plural(hits.length, "work item") : plural(hits.length, "merge request");
    const out = [`"${query}" in ${scope} · ${what}, most recently updated first`];
    for (const h of hits) {
      const typeAndStatus = [labelValue(h.labels, "Type"), labelValue(h.labels, "Status")].filter((s) => s !== undefined);
      out.push([
        this.ref(h.ref), h.state, h.title,
        typeAndStatus.length ? typeAndStatus.join("/") : "",
        `updated ${h.updatedAt}`, h.url,
      ].filter((s) => s !== "").join(" · "));
    }
    if (hits.length === 0) out.push("(no match; try other words, or state 'all')");
    return out.join("\n");
  }
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "less than a minute" : `${m} min`;
}

/** One line per job: id, kind, target, status, and the memory path of its result. */
export function formatJobLine(job: Job, position: number | undefined, now: number): string {
  const status = job.status === "queued" ? `queued${position ? ` (position ${position})` : ""}`
    : job.status === "running" ? `running for ${minutes(now - (job.startedAt ?? now))}${job.step ? `, last step: ${job.step}` : ""}`
    : job.outcome?.reused ? `reused: ${job.outcome.reused}`
    : job.status === "done" ? `done in ${minutes((job.endedAt ?? now) - (job.startedAt ?? now))}`
    : `failed: ${job.error}`;
  const result = job.outcome?.resultPath ? ` · result: ${job.outcome.resultPath}` : job.outcome?.warning ? ` · ${job.outcome.warning}` : "";
  return `${job.id} · ${job.kind.replace("_", " ")} · ${job.target} · ${status}${result}`;
}

/** A finished job: its status line, then its result. */
export function formatJob(job: Job, now: number): string {
  const out = [formatJobLine(job, undefined, now)];
  if (job.outcome) {
    if (job.outcome.warning) out.push(`Warning: ${job.outcome.warning}.`);
    out.push("", job.outcome.text.trim());
  }
  return out.join("\n");
}

export function formatJobs(jobs: { job: Job; position: number | undefined }[], now: number): string {
  if (jobs.length === 0) return "No analysis job since the analyst server started (jobs are kept for a day).";
  return ["Analysis jobs, newest first:", ...jobs.map(({ job, position }) => formatJobLine(job, position, now))].join("\n");
}

export function formatError(error: unknown): string {
  if (error instanceof AnalystError) return `Error: ${error.message}`;
  return "Error: internal error in the analyst service";
}
