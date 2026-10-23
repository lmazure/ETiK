import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentTools } from "../src/engine/agent-tools.js";
import { AnalystError } from "../src/errors.js";
import { GitLabClient } from "../src/gitlab/client.js";
import { MergeRequests } from "../src/gitlab/merge-requests.js";
import { Search } from "../src/gitlab/search.js";
import { WorkItems } from "../src/gitlab/work-items.js";
import { Formatter } from "../src/mcp/format.js";
import type { Services } from "../src/mcp/server.js";
import { checkPath, checkRevision } from "../src/repos/git.js";
import { Repos, type Checkout } from "../src/repos/repos.js";
import { fakeGitLab, GROUP, sourceRepository, STAGING } from "./helpers.js";

const PROJECT = "acme/core/app";
let dir: string;
let source: Awaited<ReturnType<typeof sourceRepository>>;
let repos: Repos;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "analyst-repos-"));
  source = await sourceRepository(join(dir, "source"));
  repos = new Repos({ dir: join(dir, "repos"), groups: ["acme/core"], cloneUrl: () => source.path, gitEnv: {}, partial: false, gitlab: undefined });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function expectError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AnalystError);
    expect((e as AnalystError).code).toBe(code);
    return;
  }
  throw new Error("no error");
}

describe("validation of the agent's inputs", () => {
  it("accepts revisions, refuses options and shell syntax", () => {
    for (const rev of ["main", "HEAD~2", "abc123^", "v1.2.0", "feature/x"]) expect(checkRevision(rev)).toBe(rev);
    for (const rev of ["--output=/tmp/x", "-p", "a b", "a;b", "$(x)", "a`b`"]) expectError(() => checkRevision(rev), "INVALID_ARGUMENT");
  });

  it("keeps paths inside the checkout", () => {
    expect(checkPath("/w/p", "src/A.java")).toBe("src/A.java");
    expect(checkPath("/w/p", "./src/../src/A.java")).toBe("src/A.java");
    expect(checkPath("/w/p", "")).toBe(".");
    for (const path of ["../x", "/etc/passwd", "src/../../x"]) expectError(() => checkPath("/w/p", path), "INVALID_ARGUMENT");
  });
});

describe("Repos", () => {
  it("only checks out projects of the configured groups", async () => {
    expect(repos.isAllowed(PROJECT)).toBe(true);
    expect(repos.isAllowed("acme/other/app")).toBe(false);
    expect(repos.isAllowed("acme/core")).toBe(false);
    expect(repos.isAllowed("acme/core/../x")).toBe(false);
    await expect(repos.checkout("job-1", "acme/other/app")).rejects.toThrow(/cannot be checked out/);
  });

  it("clones, checks out the default branch head for a job, fetches for the next one, and cleans up", async () => {
    const first = await repos.checkout("job-1", PROJECT);
    expect(first).toMatchObject({ project: PROJECT, branch: "main", path: join(dir, "repos", "work", "job-1", PROJECT) });
    expect(await readFile(join(first.path, "src/Export.java"), "utf8")).toContain("class Export");
    expect(await repos.checkout("job-1", PROJECT)).toEqual(first);

    const newSha = await source.commit("src/Other.java", "class Other {}\n");
    const second = await repos.checkout("job-2", PROJECT);
    expect(second.sha).toBe(newSha);
    expect(second.sha).not.toBe(first.sha);

    await repos.removeJob("job-1", [first]);
    await expect(stat(repos.jobDir("job-1"))).rejects.toThrow();
    expect((await stat(second.path)).isDirectory()).toBe(true);
  });
});

describe("agent tools", () => {
  async function connect(checkouts: Map<string, Checkout>) {
    const fake = fakeGitLab();
    const gitlab = new GitLabClient({ baseUrl: "https://gitlab.com", token: "t", timeoutMs: 1000, fetch: fake.fetch });
    const refs = { gitlabUrl: "https://gitlab.com", defaultProject: STAGING };
    const services: Services = {
      workItems: new WorkItems(gitlab, refs), mergeRequests: new MergeRequests(gitlab, refs), search: new Search(gitlab, refs, GROUP),
      formatter: new Formatter(STAGING), refs, maxOutputChars: 40_000,
    };
    const server = agentTools({ jobId: "job-1", services, repos, gitEnv: {}, gitlabUrl: "https://gitlab.com", checkouts });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await (server.instance as unknown as McpServer).connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0]!.text, isError: result.isError ?? false };
    };
    return { client, call };
  }

  it("lists the analyst's tools", async () => {
    const { client } = await connect(new Map());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "git_blame", "git_diff", "git_log", "git_show", "gitlab_merge_request", "gitlab_search", "gitlab_work_item", "repo_checkout", "repo_list",
    ]);
  });

  it("checks out a project and reads its history", async () => {
    const checkouts = new Map<string, Checkout>();
    const { call } = await connect(checkouts);
    expect((await call("git_log", { project: PROJECT })).text).toContain("call repo_checkout first");

    const checkout = await call("repo_checkout", { project: PROJECT });
    const sha = checkouts.get(PROJECT)!.sha;
    expect(checkout.text).toContain(`${PROJECT} checked out at main ${sha}`);
    expect(checkout.text).toContain(`permalinks: https://gitlab.com/${PROJECT}/-/blob/${sha}/<path>#L<from>-<to>`);

    expect((await call("git_log", { project: PROJECT, path: "src" })).text).toMatch(new RegExp(`^${sha} \\d{4}-\\d\\d-\\d\\d dev: Change src/Export.java$`));
    expect((await call("git_show", { project: PROJECT, rev: "HEAD", path: "src/Export.java" })).text).toContain("void run()");
    expect((await call("git_show", { project: PROJECT, rev: "HEAD" })).text).toContain("+class Export {");
    expect((await call("git_blame", { project: PROJECT, path: "src/Export.java", from_line: 2, to_line: 3 })).text).toContain("void run()");
    expect((await call("git_diff", { project: PROJECT, from: "HEAD", to: "HEAD" })).text).toBe("(no difference)");
  });

  it("refuses paths outside the checkout and bad revisions", async () => {
    const { call } = await connect(new Map());
    await call("repo_checkout", { project: PROJECT });
    const outside = await call("git_show", { project: PROJECT, rev: "HEAD", path: "../../../etc/passwd" });
    expect(outside).toEqual({ text: "Error: '../../../etc/passwd' is outside the checkout.", isError: true });
    expect((await call("git_show", { project: PROJECT, rev: "--output=/tmp/x" })).text).toContain("is not a revision");
    expect((await call("repo_checkout", { project: "acme/other/app" })).text).toContain("cannot be checked out");
  });

  it("reads GitLab with the tester's readers", async () => {
    const { call } = await connect(new Map());
    expect((await call("gitlab_work_item", { ref: "#100" })).text).toContain("#100 · UserStory (Issue) · closed");
  });
});
