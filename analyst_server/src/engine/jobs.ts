/**
 * The queue of analyses. A job lives in the server process, independently of the HTTP request that started it:
 * a caller that goes away does not stop it, and `analyst_job` finds it later. Finished jobs are kept for a day.
 */
import { randomBytes } from "node:crypto";
import { AnalystError } from "../errors.js";

export type JobKind = "story_brief" | "fix_brief" | "investigation";
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobOutcome {
  text: string;
  /** Where the result was stored in the memory server; undefined when it could not be. */
  resultPath: string | undefined;
  commits: string[];
  warning: string | undefined;
}

export interface Job {
  id: string;
  kind: JobKind;
  /** What is analysed, for people: `#8131`, `/sessions/003/issues/002/issue.md`… */
  target: string;
  key: string;
  status: JobStatus;
  createdAt: number;
  startedAt: number | undefined;
  endedAt: number | undefined;
  /** The last step of the agent, for the progress notifications. */
  step: string | undefined;
  outcome: JobOutcome | undefined;
  error: string | undefined;
  /** Settles when the job is done or failed; never rejects. */
  finished: Promise<void>;
}

export type Task = (job: Job, signal: AbortSignal) => Promise<JobOutcome>;

export interface QueueOptions {
  maxJobs: number;
  timeoutMs: number;
  retentionMs?: number;
  now?: () => number;
}

interface Pending {
  job: Job;
  task: Task;
  settle: () => void;
}

export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly waiting: Pending[] = [];
  private running = 0;
  private readonly now: () => number;

  constructor(private readonly options: QueueOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Queues a task, or returns the queued or running job of the same key. */
  submit(kind: JobKind, target: string, key: string, task: Task): Job {
    this.forgetOld();
    const existing = [...this.jobs.values()].find((j) => j.key === key && (j.status === "queued" || j.status === "running"));
    if (existing) return existing;
    let settle!: () => void;
    const finished = new Promise<void>((resolve) => (settle = resolve));
    const job: Job = {
      id: `job-${randomBytes(4).toString("hex")}`, kind, target, key, status: "queued", createdAt: this.now(),
      startedAt: undefined, endedAt: undefined, step: undefined, outcome: undefined, error: undefined, finished,
    };
    this.jobs.set(job.id, job);
    this.waiting.push({ job, task, settle });
    this.next();
    return job;
  }

  get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new AnalystError("NOT_FOUND", `No job '${id}': it never existed, was finished more than a day ago, or the analyst server restarted. Call analyst_job without id to list the jobs.`);
    return job;
  }

  /** Newest first. */
  list(): Job[] {
    this.forgetOld();
    return [...this.jobs.values()].reverse();
  }

  /** 1 for the next job to start; undefined when not queued. */
  position(job: Job): number | undefined {
    const index = this.waiting.findIndex((p) => p.job === job);
    return index < 0 ? undefined : index + 1;
  }

  private next(): void {
    while (this.running < this.options.maxJobs && this.waiting.length > 0) {
      const pending = this.waiting.shift()!;
      this.running++;
      void this.execute(pending);
    }
  }

  private async execute({ job, task, settle }: Pending): Promise<void> {
    job.status = "running";
    job.startedAt = this.now();
    const controller = new AbortController();
    const minutes = Math.round(this.options.timeoutMs / 60_000);
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${minutes} min`)), this.options.timeoutMs);
    try {
      const outcome = await Promise.race([
        task(job, controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
      ]);
      job.outcome = outcome;
      job.status = "done";
    } catch (error) {
      const cause = controller.signal.aborted ? controller.signal.reason : error;
      job.error = cause instanceof Error ? cause.message : String(cause);
      job.status = "failed";
    } finally {
      clearTimeout(timer);
      job.endedAt = this.now();
      // The next job starts before anyone waiting for this one is told.
      this.running--;
      this.next();
      settle();
    }
  }

  private forgetOld(): void {
    const limit = this.now() - (this.options.retentionMs ?? 24 * 60 * 60_000);
    for (const [id, job] of this.jobs) {
      if (job.endedAt !== undefined && job.endedAt < limit) this.jobs.delete(id);
    }
  }
}
