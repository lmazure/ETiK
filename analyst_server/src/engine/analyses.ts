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
  | { kind: "story_brief" | "fix_brief"; ref: string }
  | { kind: "investigation"; issueReport?: string; description?: string };

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

  /** Starts the analysis, or returns the job already doing it. */
  start(request: AnalysisRequest): Job {
    const { runner, services } = this.options;
    if (!runner) {
      throw new AnalystError("NOT_CONFIGURED", "The analyses are not available: the analyst server has no CLAUDE_CODE_OAUTH_TOKEN. The GitLab tools still work.");
    }
    if (request.kind === "investigation") {
      const report = request.issueReport?.trim() || undefined;
      const description = request.description?.trim() || undefined;
      if (!report && !description) throw new AnalystError("INVALID_ARGUMENT", "Give issue_report (the path of an issue report in the memory server) or description, or both.");
      if (report && !ISSUE_REPORT.test(report)) {
        throw new AnalystError("INVALID_ARGUMENT", `'${report}' is not the path of an issue report, such as /sessions/003/issues/002/issue.md.`);
      }
      if (report && !this.options.memory) {
        throw new AnalystError("NOT_CONFIGURED", "The analyst server has no MEMORY_AGENT_TOKEN, so it cannot read issue reports: pass the problem as description instead.");
      }
      const key = `investigation:${report ?? createHash("sha256").update(description!).digest("hex").slice(0, 16)}`;
      return this.options.queue.submit("investigation", report ?? `"${description!.slice(0, 60)}${description!.length > 60 ? "…" : ""}"`, key,
        (job, signal) => this.execute(job, signal, { kind: "investigation", issueReport: report, description }));
    }
    const ref = parseRef(request.ref, "work_item", services.refs);
    const target = formatRef(ref, services.refs.defaultProject);
    return this.options.queue.submit(request.kind, target, `${request.kind}:${ref.path}#${ref.iid}`,
      (job, signal) => this.execute(job, signal, { kind: request.kind, ref }));
  }

  private resultPath(job: Job, input: { kind: JobKind; ref?: Ref; issueReport?: string }): string {
    if (input.ref) return `${workItemFolder(input.ref, this.options.services.refs.defaultProject)}/${FILE_NAMES[input.kind]}`;
    const match = input.issueReport ? ISSUE_REPORT.exec(input.issueReport) : null;
    if (match) return `/analyses/sessions/${match[1]}/issues/${match[2]}/analysis.md`;
    return `/analyses/jobs/${job.id}/analysis.md`;
  }

  private async execute(job: Job, signal: AbortSignal, input: { kind: JobKind; ref?: Ref; issueReport?: string; description?: string }): Promise<JobOutcome> {
    const { runner, repos, memory, services } = this.options;
    const checkouts = new Map<string, Checkout>();
    const jobDir = repos.jobDir(job.id);
    try {
      await mkdir(jobDir, { recursive: true });
      const issueReport = input.issueReport && memory ? { path: input.issueReport, content: await memory.read(input.issueReport) } : undefined;
      const reference = input.ref ? formatRef(input.ref, services.refs.defaultProject) : undefined;
      const result = await runner!.run({
        systemPrompt: systemPrompt(this.options.gitlabUrl),
        prompt: taskPrompt({ kind: input.kind, reference, issueReport, description: input.description }),
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
            metadata: { kind: input.kind, job_id: job.id, target: job.target, commits: commits.join(", "), model: runner!.model },
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
