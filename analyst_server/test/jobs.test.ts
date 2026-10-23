import { describe, expect, it } from "vitest";
import { JobQueue, type JobOutcome } from "../src/engine/jobs.js";

const outcome = (text: string): JobOutcome => ({ text, resultPath: undefined, commits: [], warning: undefined });

function deferred() {
  let resolve!: (o: JobOutcome) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<JobOutcome>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("JobQueue", () => {
  it("runs one job at a time, in order, and tells the queue position", async () => {
    const queue = new JobQueue({ maxJobs: 1, timeoutMs: 60_000 });
    const a = deferred();
    const b = deferred();
    const first = queue.submit("fix_brief", "#1", "k1", () => a.promise);
    const second = queue.submit("story_brief", "#2", "k2", () => b.promise);
    expect([first.status, second.status]).toEqual(["running", "queued"]);
    expect(queue.position(second)).toBe(1);
    a.resolve(outcome("one"));
    await first.finished;
    expect(first).toMatchObject({ status: "done", outcome: { text: "one" } });
    expect(second.status).toBe("running");
    b.reject(new Error("boom"));
    await second.finished;
    expect(second).toMatchObject({ status: "failed", error: "boom" });
    expect(queue.list().map((j) => j.id)).toEqual([second.id, first.id]);
  });

  it("reuses a queued or running job of the same key, not a finished one", async () => {
    const queue = new JobQueue({ maxJobs: 1, timeoutMs: 60_000 });
    const a = deferred();
    const first = queue.submit("fix_brief", "#1", "same", () => a.promise);
    expect(queue.submit("fix_brief", "#1", "same", () => a.promise)).toBe(first);
    a.resolve(outcome("x"));
    await first.finished;
    expect(queue.submit("fix_brief", "#1", "same", async () => outcome("y"))).not.toBe(first);
  });

  it("fails a job that runs too long, and aborts its signal", async () => {
    const queue = new JobQueue({ maxJobs: 1, timeoutMs: 20 });
    let aborted = false;
    const job = queue.submit("investigation", "x", "k", (_job, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    }));
    await job.finished;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("timed out");
    expect(aborted).toBe(true);
  });

  it("forgets finished jobs after the retention time", async () => {
    let now = 1_000;
    const queue = new JobQueue({ maxJobs: 1, timeoutMs: 60_000, retentionMs: 100, now: () => now });
    const job = queue.submit("fix_brief", "#1", "k", async () => outcome("x"));
    await job.finished;
    expect(queue.get(job.id)).toBe(job);
    now += 101;
    expect(queue.list()).toEqual([]);
    expect(() => queue.get(job.id)).toThrow(/No job/);
  });
});
