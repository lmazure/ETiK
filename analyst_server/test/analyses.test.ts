import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Runner, RunRequest, RunResult } from "../src/engine/runner.js";
import { MemoryClient } from "../src/memory.js";
import { ANALYST_TOKEN, fakeGitLab, GITLAB_TOKEN, ISSUE_REPORT, json, sourceRepository, testConfig, type FakeGitLab } from "./helpers.js";

const PROJECT = "acme/core/app";

/** Stands for the agent: checks out the project through the analyst's tools, then answers. */
class FakeRunner implements Runner {
  readonly model = "fake-model";
  requests: RunRequest[] = [];
  answer = "# Fix brief: #100\n\n## Summary\n\nThe fix looks right.";
  delayMs = 0;
  failure: Error | undefined;

  async run(request: RunRequest): Promise<RunResult> {
    this.requests.push(request);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await (request.tools.instance as unknown as McpServer).connect(serverSide);
    const client = new Client({ name: "fake-agent", version: "1" });
    await client.connect(clientSide);
    await client.callTool({ name: "repo_checkout", arguments: { project: PROJECT } });
    request.onStep("git_log acme/core/app");
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failure) throw this.failure;
    return { text: this.answer, turns: 7 };
  }
}

let dir: string;
let app: FastifyInstance;
let base: string;
let fake: FakeGitLab;
let runner: FakeRunner;

async function start(overrides: Parameters<typeof testConfig>[0] = {}, withRunner = true) {
  dir = await mkdtemp(join(tmpdir(), "analyst-analyses-"));
  const source = await sourceRepository(join(dir, "source"));
  fake = fakeGitLab();
  runner = new FakeRunner();
  app = buildApp(testConfig({ reposDir: join(dir, "repos"), repoGroups: ["acme/core"], ...overrides }), {}, {
    fetch: fake.fetch, runner: withRunner ? runner : undefined, cloneUrl: () => source.path, partialClone: false, progressIntervalMs: 20,
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}

afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "tester", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { Authorization: `Bearer ${ANALYST_TOKEN}` } } }));
  return client;
}

type TextResult = { content: { text: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown>, onprogress?: (p: { progress: number; message?: string }) => void): Promise<TextResult> {
  const client = await connect();
  try {
    return (await client.callTool({ name, arguments: args }, undefined, onprogress ? { onprogress, resetTimeoutOnProgress: true } : undefined)) as TextResult;
  } finally {
    await client.close();
  }
}

describe("analysis tools", () => {
  beforeEach(async () => start());

  it("analyst_fix_brief runs the agent, completes and stores its answer, with progress notifications", async () => {
    runner.delayMs = 120;
    const progress: string[] = [];
    const result = await call("analyst_fix_brief", { ref: "#100" }, (p) => progress.push(p.message ?? ""));
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/^job-[0-9a-f]{8} · fix brief · #100 · done in .* · result: \/analyses\/work-items\/100\/fix-brief\.md/);
    expect(text).toContain("The fix looks right.");
    expect(text).toMatch(new RegExp(`## Analysed code\\n\\n- ${PROJECT} at main \\(\`[0-9a-f]{40}\`\\)\\n- Analysed by fake-model \\(ETiK analyst, job job-[0-9a-f]{8}, 7 turns\\)`));
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.some((m) => m.includes("running for") && m.includes("last step: git_log acme/core/app"))).toBe(true);

    const stored = fake.memory.get("/analyses/work-items/100/fix-brief.md")!;
    expect(stored.content).toContain("The fix looks right.");
    expect(stored.body).toMatchObject({ tags: ["analysis", "fix-brief"], description: "Fix brief of #100", metadata: { kind: "fix_brief", target: "#100", model: "fake-model" } });
    expect((stored.body!.metadata as Record<string, string>).commits).toMatch(new RegExp(`^${PROJECT}@[0-9a-f]{40}$`));
    expect(stored.body!.change_note).toMatch(/^analyst: fix brief of #100 \(job job-/);

    // The prompt names the work item; the job's worktrees are removed at the end.
    expect(runner.requests[0]!.prompt).toContain("verify the fix of the bug #100");
    await expect(stat(runner.requests[0]!.jobDir)).rejects.toThrow();
  });

  it("analyst_investigate reads the issue report and stores the analysis next to it; analyst_job lists the jobs", async () => {
    const result = await call("analyst_investigate", { issue_report: ISSUE_REPORT });
    expect(result.content[0]!.text).toContain("result: /analyses/sessions/003/issues/002/analysis.md");
    expect(runner.requests[0]!.prompt).toContain("<issue_report>\n# [Export] The export fails");
    expect(fake.memory.has("/analyses/sessions/003/issues/002/analysis.md")).toBe(true);

    await call("analyst_story_brief", { ref: "https://gitlab.com/henixdevelopment/squash/squash-tm/tm-plugin/api/henix-tm-api-rest-admin/-/work_items/5" });
    expect(fake.memory.has("/analyses/work-items/henix-tm-api-rest-admin-5/story-brief.md")).toBe(true);

    const list = (await call("analyst_job", {})).content[0]!.text;
    expect(list.split("\n")).toHaveLength(3);
    expect(list).toMatch(/story brief · henixdevelopment\/squash\/squash-tm\/tm-plugin\/api\/henix-tm-api-rest-admin#5 · done/);
    expect(list).toMatch(/investigation · \/sessions\/003\/issues\/002\/issue\.md · done in .* · result: \/analyses\/sessions\/003\/issues\/002\/analysis\.md/);
    const id = /(job-[0-9a-f]{8}) · investigation/.exec(list)![1]!;
    expect((await call("analyst_job", { job_id: id })).content[0]!.text).toContain("The fix looks right.");
  });

  it("an investigation of a description goes under /analyses/jobs/", async () => {
    const result = await call("analyst_investigate", { description: "Exporting a campaign with 0 test fails with a 500." });
    expect(result.content[0]!.text).toMatch(/result: \/analyses\/jobs\/job-[0-9a-f]{8}\/analysis\.md/);
    expect(runner.requests[0]!.prompt).toContain("<description>\nExporting a campaign with 0 test fails with a 500.\n</description>");
  });

  it("scrubs the server's secrets from the answer", async () => {
    runner.answer = `Token ${GITLAB_TOKEN}-suffix and memory-secret and ${ANALYST_TOKEN}`;
    const text = (await call("analyst_fix_brief", { ref: "#100" })).content[0]!.text;
    expect(text).toContain("Token [redacted]-suffix and [redacted] and [redacted]");
    expect(fake.memory.get("/analyses/work-items/100/fix-brief.md")!.content).not.toContain(GITLAB_TOKEN);
  });

  it("returns the answer with a warning when it cannot be stored", async () => {
    fake.memory.clear();
    const original = fake.fetch;
    fake.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("http://memory.test") ? json({ error: { message: "down" } }, 503) : original(input, init)) as typeof fetch;
    // The app captured the fetch at build time: rebuild it with the failing one.
    await app.close();
    app = buildApp(testConfig({ reposDir: join(dir, "repos"), repoGroups: ["acme/core"] }), {}, { fetch: fake.fetch, runner, cloneUrl: () => join(dir, "source"), partialClone: false });
    base = await app.listen({ host: "127.0.0.1", port: 0 });
    const text = (await call("analyst_fix_brief", { ref: "#100" })).content[0]!.text;
    expect(text).toContain("Warning: the result could not be stored in the memory server: Cannot write /analyses/work-items/100/fix-brief.md: memory server answered 503 (down).");
    expect(text).toContain("The fix looks right.");
  });

  it("reports a failed job and bad inputs", async () => {
    runner.failure = new Error("the agent stopped (error_max_turns)");
    const failed = await call("analyst_fix_brief", { ref: "#100" });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).toMatch(/^Error: Job job-[0-9a-f]{8} \(fix brief of #100\) failed: the agent stopped \(error_max_turns\)$/);
    expect((await call("analyst_investigate", {})).content[0]!.text).toContain("Give issue_report");
    expect((await call("analyst_investigate", { issue_report: "/knowledge/x.md" })).content[0]!.text).toContain("is not the path of an issue report");
    expect((await call("analyst_job", { job_id: "job-00000000" })).content[0]!.text).toContain("No job 'job-00000000'");
  });
});

describe("without the subscription token", () => {
  it("refuses the analyses but keeps the GitLab tools", async () => {
    await start({}, false);
    const result = await call("analyst_story_brief", { ref: "#100" });
    expect(result.content[0]!.text).toContain("no CLAUDE_CODE_OAUTH_TOKEN");
    expect((await call("gitlab_work_item", { ref: "#100" })).isError).toBeUndefined();
  });
});

describe("MemoryClient", () => {
  it("overwrites an existing document, creates a missing one, and reads", async () => {
    const local = fakeGitLab();
    const memory = new MemoryClient({ url: "http://memory.test", token: "memory-secret", store: "squashtm", fetch: local.fetch });
    const request = { text: "v1", description: "d", tags: ["analysis"], metadata: {}, changeNote: "analyst: x" };
    expect(await memory.write("/analyses/a.md", request)).toEqual({ path: "/analyses/a.md", version: 1, created: true });
    expect(await memory.write("/analyses/a.md", { ...request, text: "v2" })).toMatchObject({ created: false });
    expect(await memory.read("/analyses/a.md")).toBe("v2");
    expect(local.requests.every((r) => r.authorization === "Bearer memory-secret")).toBe(true);
    await expect(memory.read("/missing.md")).rejects.toThrow(/Cannot read \/missing\.md: memory server answered 404/);
  });
});
