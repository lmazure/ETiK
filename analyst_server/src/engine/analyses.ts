/**
 * The three analyses: from a request, a job that checks out code, runs the agent, completes and scrubs its answer,
 * stores it in the memory server, and cleans up its worktrees.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { AnalystError } from "../errors.js";
import { formatRef, parseRef, type Ref } from "../gitlab/refs.js";
import type { MemoryClient } from "../memory.js";
import type { Services } from "../mcp/server.js";
import type { Checkout, Repos } from "../repos/repos.js";
import { scrub } from "../secrets.js";
import { agentTools } from "./agent-tools.js";
import type { Job, JobKind, JobOutcome, JobQueue } from "./jobs.js";
import { systemPrompt, taskPrompt } from "./prompts.js";
import type { Runner } from "./runner.js";

export type AnalysisRequest =
  | { kind: "story_brief" | "fix_brief"; ref: string; refresh?: boolean }
  | { kind: "investigation"; issueReport?: string; workItem?: string; description?: string; refresh?: boolean };

/** What a job analyses: a work item (briefs, investigation of a GitLab issue), an issue report, a description. */
interface Input {
  kind: JobKind;
  ref?: Ref;
  issueReport?: string;
  description?: string;
}

export interface AnalysesOptions {
  queue: JobQueue;
  /** Undefined when CLAUDE_CODE_OAUTH_TOKEN is not set. */
  runner: Runner | undefined;
  repos: Repos;
  /** Undefined when MEMORY_AGENT_TOKEN is not set. */
  memory: MemoryClient | undefined;
  services: Services;
  gitlabUrl: string;
  gitEnv: Record<string, string>;
  /** Removed from every result. */
  secrets: (string | undefined)[];
  /** A stored result younger than this, whose source has not changed, is returned instead of a new analysis; 0: never. */
  reuseHours: number;
  now?: () => number;
}

const ISSUE_REPORT = /^\/sessions\/(\d{3})\/issues\/(\d{3})\/issue\.md$/;
const FILE_NAMES: Record<JobKind, string> = { story_brief: "story-brief.md", fix_brief: "fix-brief.md", investigation: "analysis.md" };
const TITLES: Record<JobKind, string> = { story_brief: "Story brief", fix_brief: "Fix brief", investigation: "Code analysis" };

/** `/analyses/work-items/<key>/`: the iid in the default project, else `<last path segment>-<iid>`. */
export function workItemFolder(ref: Ref, defaultProject: string): string {
  return `/analyses/work-items/${ref.path === defaultProject ? ref.iid : `${ref.path.split("/").pop()}-${ref.iid}`}`;
}

export class Analyses {
  constructor(private readonly options: AnalysesOptions) {}

  /**
   * Starts the analysis, or returns the job already doing it, or, unless `refresh`, a finished job holding the stored
   * result when its source has not changed since and it is recent enough.
   */
  async start(request: AnalysisRequest): Promise<Job> {
    const { runner, services, queue } = this.options;
    if (!runner) {
      throw new AnalystError("NOT_CONFIGURED", "The analyses are not available: the analyst server has no CLAUDE_CODE_OAUTH_TOKEN. The GitLab tools still work.");
    }
    let input: Input;
    let target: string;
    let key: string;
    if (request.kind === "investigation") {
      const report = request.issueReport?.trim() || undefined;
      const workItem = request.workItem?.trim() || undefined;
      const description = request.description?.trim() || undefined;
      if (!report && !workItem && !description) {
        throw new AnalystError("INVALID_ARGUMENT", "Give issue_report (the path of an issue report in the memory server), work_item (a GitLab issue) or description, or several of them.");
      }
      if (report && !ISSUE_REPORT.test(report)) {
        throw new AnalystError("INVALID_ARGUMENT", `'${report}' is not the path of an issue report, such as /sessions/003/issues/002/issue.md.`);
      }
      if (report && !this.options.memory) {
        throw new AnalystError("NOT_CONFIGURED", "The analyst server has no MEMORY_AGENT_TOKEN, so it cannot read issue reports: pass the problem as description instead.");
      }
      const ref = workItem ? parseRef(workItem, "work_item", services.refs) : undefined;
      input = { kind: "investigation", ref, issueReport: report, description };
      target = report ?? (ref ? formatRef(ref, services.refs.defaultProject) : `"${description!.slice(0, 60)}${description!.length > 60 ? "…" : ""}"`);
      key = `investigation:${report ?? (ref ? `${ref.path}#${ref.iid}` : createHash("sha256").update(description!).digest("hex").slice(0, 16))}`;
    } else {
      const ref = parseRef(request.ref, "work_item", services.refs);
      input = { kind: request.kind, ref };
      target = formatRef(ref, services.refs.defaultProject);
      key = `${request.kind}:${ref.path}#${ref.iid}`;
    }
    const active = queue.active(key);
    if (active) return active;
    if (!request.refresh) {
      const reused = await this.reusable(input);
      if (reused) return queue.completed(input.kind, target, key, reused);
    }
    return queue.submit(input.kind, target, key, (job, signal) => this.execute(job, signal, input));
  }

  /** The stored result, when its source is unchanged and it is younger than the reuse window; else undefined. */
  private async reusable(input: Input): Promise<JobOutcome | undefined> {
    const { memory, services, reuseHours } = this.options;
    if (!memory || reuseHours <= 0 || (!input.ref && !input.issueReport)) return undefined;
    const path = this.resultPath(undefined, input);
    const stored = await memory.lookup(path).catch(() => undefined);
    if (!stored) return undefined;
    const age = (this.options.now ?? Date.now)() - Date.parse(stored.updated_at);
    if (!(age >= 0 && age < reuseHours * 3_600_000)) return undefined;
    let unchanged: string;
    if (input.issueReport) {
      const report = await memory.lookup(input.issueReport).catch(() => undefined);
      if (!report || stored.metadata.source_version !== String(report.version)) return undefined;
      unchanged = "the issue report has not changed since";
    } else {
      const updatedAt = await services.workItems.updatedAt(input.ref!).catch(() => undefined);
      if (!updatedAt || stored.metadata.work_item_updated_at !== updatedAt) return undefined;
      unchanged = "the work item has not changed since";
    }
    const hours = age / 3_600_000;
    const when = hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min ago` : `${Math.round(hours)} h ago`;
    return {
      text: stored.content,
      resultPath: path,
      commits: (stored.metadata.commits ?? "").split(", ").filter((c) => c !== ""),
      warning: undefined,
      reused: `analysed ${when}, ${unchanged} (refresh: true to analyse again)`,
    };
  }

  /** Next to the issue report, else under the work item, else under the job (a description). */
  private resultPath(job: Job | undefined, input: Input): string {
    const match = input.issueReport ? ISSUE_REPORT.exec(input.issueReport) : null;
    if (match) return `/analyses/sessions/${match[1]}/issues/${match[2]}/analysis.md`;
    if (input.ref) return `${workItemFolder(input.ref, this.options.services.refs.defaultProject)}/${FILE_NAMES[input.kind]}`;
    return `/analyses/jobs/${job!.id}/analysis.md`;
  }

  private async execute(job: Job, signal: AbortSignal, input: Input): Promise<JobOutcome> {
    const { runner, repos, memory, services } = this.options;
    const checkouts = new Map<string, Checkout>();
    const jobDir = repos.jobDir(job.id);
    try {
      await mkdir(jobDir, { recursive: true });
      // What the reuse of the result is checked against: the version of the report, the update time of the work item.
      const report = input.issueReport && memory ? await memory.lookup(input.issueReport) : undefined;
      if (input.issueReport && !report) throw new AnalystError("NOT_FOUND", `No issue report at ${input.issueReport} in the memory server.`);
      const workItemUpdatedAt = input.ref ? await services.workItems.updatedAt(input.ref) : undefined;
      const reference = input.ref ? formatRef(input.ref, services.refs.defaultProject) : undefined;
      const result = await runner!.run({
        systemPrompt: systemPrompt(this.options.gitlabUrl),
        prompt: taskPrompt({
          kind: input.kind,
          reference,
          issueReport: report ? { path: input.issueReport!, content: report.content } : undefined,
          description: input.description,
        }),
        jobDir,
        tools: agentTools({ jobId: job.id, services, repos, gitEnv: this.options.gitEnv, gitlabUrl: this.options.gitlabUrl, checkouts }),
        signal,
        onStep: (step) => (job.step = step),
      });
      const commits = [...checkouts.values()].map((c) => `${c.project}@${c.sha}`);
      const analysed = [
        "",
        "## Analysed code",
        "",
        ...(checkouts.size
          ? [...checkouts.values()].map((c) => `- ${c.project} at ${c.branch} (\`${c.sha}\`)`)
          : ["- No code checked out."]),
        `- Analysed by ${runner!.model} (ETiK analyst, job ${job.id}, ${result.turns} turns), from GitLab and the code only: no build, no test run.`,
      ];
      const text = scrub(`${result.text.trim()}\n${analysed.join("\n")}\n`, this.options.secrets);

      const path = this.resultPath(job, input);
      let warning: string | undefined;
      if (memory) {
        try {
          await memory.write(path, {
            text,
            description: `${TITLES[input.kind]} of ${job.target}`,
            tags: ["analysis", input.kind.replace("_", "-")],
            metadata: {
              kind: input.kind, job_id: job.id, target: job.target, commits: commits.join(", "), model: runner!.model,
              ...(workItemUpdatedAt ? { work_item_updated_at: workItemUpdatedAt } : {}),
              ...(report ? { source_version: String(report.version) } : {}),
            },
            changeNote: `analyst: ${input.kind.replace("_", " ")} of ${job.target} (job ${job.id})`,
          });
        } catch (error) {
          warning = `the result could not be stored in the memory server: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        warning = "the result is not stored: the analyst server has no MEMORY_AGENT_TOKEN";
      }
      return { text, resultPath: warning ? undefined : path, commits, warning };
    } finally {
      await repos.removeJob(job.id, [...checkouts.values()]).catch(() => undefined);
    }
  }
}
