/**
 * A fake GitLab for the tests. The responses copy the shapes returned by gitlab.com (GraphQL work items, REST merge
 * requests, diffs, discussions, search) with invented content: no text of the real projects is stored here.
 */
import type { Config } from "../src/config.js";

export const ANALYST_TOKEN = "analyst-secret";
export const GITLAB_TOKEN = "glpat-test";
export const STAGING = "henixdevelopment/squash/squash-tm/core/squashtest-tm-staging";
export const GROUP = "henixdevelopment/squash";
export const PLUGIN = "henixdevelopment/squash/squash-tm/tm-plugin/api/henix-tm-api-rest-admin";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    analystToken: ANALYST_TOKEN,
    gitlabUrl: "https://gitlab.com",
    gitlabToken: GITLAB_TOKEN,
    defaultProject: STAGING,
    searchGroup: GROUP,
    gitlabTimeoutMs: 1_000,
    mcpMaxOutputChars: 20_000,
    claudeOauthToken: undefined,
    model: "test-model",
    maxJobs: 1,
    jobTimeoutMs: 60_000,
    repoGroups: ["henixdevelopment/squash/squash-tm"],
    reposDir: "/nonexistent",
    memoryUrl: "http://memory.test",
    memoryToken: "memory-secret",
    memoryStore: "squashtm",
    reuseHours: 24,
    ...overrides,
  };
}

const workItemUrl = (path: string, iid: number) =>
  path === GROUP ? `https://gitlab.com/groups/${path}/-/work_items/${iid}` : `https://gitlab.com/${path}/-/work_items/${iid}`;
const mrUrl = (path: string, iid: number) => `https://gitlab.com/${path}/-/merge_requests/${iid}`;

function summary(path: string, iid: number, title: string, type: string, state: string, labels: string[], closing: { iid: number; state: string }[] = []) {
  return {
    iid: String(iid), title, state, webUrl: workItemUrl(path, iid), workItemType: { name: type },
    widgets: [
      { type: "ASSIGNEES" },
      { type: "LABELS", labels: { nodes: labels.map((title) => ({ title })) } },
      ...(type === "Epic" ? [] : [{ type: "DEVELOPMENT", closingMergeRequests: { nodes: closing.map((mr) => ({ mergeRequest: { ...mr, iid: String(mr.iid), webUrl: mrUrl(STAGING, mr.iid) } })) } }]),
    ],
  };
}

function mergeRequestNode(iid: number, state: string, mergeCommitSha: string | null) {
  return {
    iid: String(iid), state, title: `Resolve "Show the export button"`, webUrl: mrUrl(STAGING, iid),
    sourceBranch: `100-show-the-export-button`, targetBranch: "main",
    mergedAt: mergeCommitSha ? "2026-10-15T14:04:15Z" : null, mergeCommitSha, headPipeline: { status: "SUCCESS" },
  };
}

/** #100, a user story under feature epic &11, under the root epic &10; siblings #101 and plugin#5. */
const workItem100 = {
  ...summary(STAGING, 100, "[Export] Show the export button", "Issue", "CLOSED", ["Priority::Medium", "Status::Validated", "Type::UserStory"]),
  createdAt: "2026-10-01T08:00:00Z", updatedAt: "2026-10-20T08:00:00Z", closedAt: "2026-10-19T09:00:00Z",
  author: { username: "po" },
  widgets: [
    { type: "ASSIGNEES", assignees: { nodes: [{ username: "qa" }] } },
    { type: "CUSTOM_FIELDS", customFieldValues: [{ customField: { name: "Dev Weight" }, value: 3 }, { customField: { name: "Notes" }, value: null }] },
    { type: "DESCRIPTION", description: "## Context\n\nUsers cannot export.\n\n## Acceptance criteria\n\n- [ ] The export button is shown on the campaign page." },
    { type: "DEVELOPMENT", closingMergeRequests: { nodes: [{ mergeRequest: mergeRequestNode(200, "merged", "a".repeat(40)) }] },
      relatedMergeRequests: { nodes: [mergeRequestNode(200, "merged", "a".repeat(40)), mergeRequestNode(201, "opened", null)] } },
    { type: "HIERARCHY", parent: { iid: "11", webUrl: workItemUrl(GROUP, 11) }, children: { nodes: [] } },
    { type: "LABELS", labels: { nodes: [{ title: "Priority::Medium" }, { title: "Status::Validated" }, { title: "Type::UserStory" }] } },
    { type: "LINKED_ITEMS", linkedItems: { nodes: [{ linkType: "RELATES_TO", workItem: summary(STAGING, 90, "[Export] Old export issue", "Issue", "OPEN", ["Type::Bug"]) }] } },
    { type: "MILESTONE", milestone: { title: "Sprint 158" } },
    { type: "NOTES", discussions: { nodes: [
      { notes: { nodes: [{ body: "Implemented, on nightly.", system: false, createdAt: "2026-10-12T10:00:00Z", author: { username: "dev" } }] } },
      { notes: { nodes: [{ body: "changed the description", system: true, createdAt: "2026-10-11T10:00:00Z", author: { username: "dev" } }] } },
      { notes: { nodes: [{ body: "Validated on nightly 19/10.", system: false, createdAt: "2026-10-19T09:00:00Z", author: { username: "qa" } }] } },
    ] } },
    { type: "STATUS", status: { name: "Done" } },
    { type: "WEIGHT", weight: 4 },
  ],
};

const families: Record<string, unknown> = {
  [`${GROUP}#11`]: {
    ...summary(GROUP, 11, "[Export] Export campaigns", "Epic", "OPEN", ["Status::Implemented", "Type::Feature"]),
    widgets: [
      { type: "LABELS", labels: { nodes: [{ title: "Status::Implemented" }, { title: "Type::Feature" }] } },
      { type: "HIERARCHY", parent: { iid: "10", webUrl: workItemUrl(GROUP, 10) }, children: { nodes: [
        summary(STAGING, 100, "[Export] Show the export button", "Issue", "CLOSED", ["Type::UserStory"]),
        summary(STAGING, 101, "[Export] Export as CSV", "Issue", "OPEN", ["Status::InProgress", "Type::UserStory"], [{ iid: 210, state: "opened" }]),
        summary(PLUGIN, 5, "[Export - API] Export endpoint", "Issue", "CLOSED", ["Type::Task"]),
      ] } },
    ],
  },
  [`${GROUP}#10`]: {
    ...summary(GROUP, 10, "Reporting", "Epic", "OPEN", ["Type::Epic"]),
    widgets: [
      { type: "LABELS", labels: { nodes: [{ title: "Type::Epic" }] } },
      { type: "HIERARCHY", parent: null, children: { nodes: [] } },
    ],
  },
};

/** relatedMergeRequests of each work item, served one per query as GitLab does. */
const related: Record<string, { iid: number; state: string }[]> = {
  [`${STAGING}#101`]: [{ iid: 210, state: "opened" }, { iid: 211, state: "merged" }],
  [`${PLUGIN}#5`]: [{ iid: 7, state: "merged" }],
};

const mergeRequest200 = {
  title: `Resolve "Show the export button"`, state: "merged", draft: false, web_url: mrUrl(STAGING, 200),
  author: { username: "dev" }, created_at: "2026-10-14T15:00:00Z", source_branch: "100-show-the-export-button", target_branch: "main",
  merge_user: { username: "lead" }, merged_at: "2026-10-15T14:04:15Z", merge_commit_sha: "a".repeat(40), squash_commit_sha: null,
  labels: ["Type::UserStory"], description: "Related to #100",
  head_pipeline: { id: 900, status: "failed", web_url: `https://gitlab.com/${STAGING}/-/pipelines/900`, project_id: 42 },
};

const diffs200 = [
  { old_path: "front/campaign.html", new_path: "front/campaign.html", new_file: false, renamed_file: false, deleted_file: false,
    diff: "@@ -1,3 +1,4 @@\n <div>\n-  <span>old</span>\n+  <span>new</span>\n+  <button>Export</button>\n </div>\n" },
  { old_path: "front/old.less", new_path: "front/new.less", new_file: false, renamed_file: true, deleted_file: false, diff: "" },
  { old_path: "front/big.json", new_path: "front/big.json", new_file: true, renamed_file: false, deleted_file: false, diff: "", too_large: true },
];

const discussions200 = [
  { individual_note: true, notes: [{ body: "added 1 commit", system: true, created_at: "2026-10-14T15:01:00Z", author: { username: "dev" }, resolvable: false }] },
  { individual_note: false, notes: [
    { body: "Should this be disabled for read-only users?", system: false, created_at: "2026-10-15T10:00:00Z", author: { username: "reviewer" }, resolvable: true, resolved: true,
      position: { new_path: "front/campaign.html", new_line: 3, old_line: null } },
    { body: "Done.", system: false, created_at: "2026-10-15T10:05:00Z", author: { username: "dev" }, resolvable: true, resolved: true },
  ] },
  { individual_note: true, notes: [{ body: "x".repeat(2_500), system: false, created_at: "2026-10-15T10:10:00Z", author: { username: "review-bot" }, resolvable: false }] },
];

const searchHits = [
  { title: "[Export] Show the export button", state: "closed", labels: ["Type::UserStory", "Status::Validated"], updated_at: "2026-10-20T08:00:00Z", web_url: `https://gitlab.com/${STAGING}/-/issues/100` },
  { title: "[Export - API] Export endpoint", state: "closed", labels: ["Type::Task"], updated_at: "2026-10-18T08:00:00Z", web_url: `https://gitlab.com/${PLUGIN}/-/issues/5` },
];

export interface FakeRequest {
  method: string;
  url: URL;
  authorization: string | undefined;
  operation: string | undefined;
  variables: Record<string, unknown> | undefined;
}

export interface FakeGitLab {
  fetch: typeof fetch;
  requests: FakeRequest[];
  /** Responses to serve first, before the routes: e.g. errors. */
  queue: Response[];
  /** Documents of the fake memory server (http://memory.test), by path. */
  memory: Map<string, MemoryDoc>;
  /** `updatedAt` of the work items, by `path#iid` (default 2026-10-20T08:00:00Z). */
  updatedAt: Map<string, string>;
  /** The clock of the fake memory server's `updated_at`. */
  now: () => number;
}

export interface MemoryDoc {
  content: string;
  body?: Record<string, unknown>;
  version: number;
  updatedAt: string;
}

export const ISSUE_REPORT = "/sessions/003/issues/002/issue.md";

/** The fake memory server: GET and PUT of /api/stores/squashtm/docs/<path>, with its create/overwrite rules. */
function memoryServer(fake: FakeGitLab, url: URL, method: string, headers: Headers, body: string | undefined): Response {
  const prefix = "/api/stores/squashtm/docs";
  if (!url.pathname.startsWith(prefix)) return json({ error: { message: "not found" } }, 404);
  const path = decodeURIComponent(url.pathname.slice(prefix.length));
  const existing = fake.memory.get(path);
  if (method === "GET") {
    return existing
      ? json({ path, content: existing.content, version: existing.version, metadata: existing.body?.metadata ?? {}, updated_at: existing.updatedAt })
      : json({ error: { message: `${path} not found` } }, 404);
  }
  const parsed = JSON.parse(body ?? "{}") as Record<string, unknown>;
  const create = headers.get("if-none-match") === "*";
  if (create && existing) return json({ error: { message: "exists" } }, 409);
  if (!create && !existing) return json({ error: { message: "not found" } }, 404);
  const version = (existing?.version ?? 0) + 1;
  fake.memory.set(path, { content: String(parsed.file_text), body: parsed, version, updatedAt: new Date(fake.now()).toISOString() });
  return json({ path, version, created: create }, create ? 201 : 200);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function graphql(fake: FakeGitLab, operation: string | undefined, variables: Record<string, unknown>): unknown {
  const key = `${variables.fullPath}#${variables.iid}`;
  const workItem = (item: unknown) => ({ data: { namespace: { workItem: item ?? null } } });
  switch (operation) {
    case "AnalystWorkItem": return workItem(key === `${STAGING}#100` ? workItem100 : undefined);
    case "AnalystWorkItemFamily": return workItem(families[key]);
    case "AnalystWorkItemUpdatedAt": return workItem({ updatedAt: fake.updatedAt.get(key) ?? "2026-10-20T08:00:00Z", widgets: [] });
    case "AnalystRelatedMergeRequests":
      return workItem({ widgets: [{ type: "DEVELOPMENT", relatedMergeRequests: { nodes: (related[key] ?? []).map((mr) => ({ iid: String(mr.iid), state: mr.state, webUrl: mrUrl(STAGING, mr.iid) })) } }] });
    default: return { errors: [{ message: `unknown operation ${operation}` }] };
  }
}

function rest(url: URL): Response {
  const mr = `/api/v4/projects/${encodeURIComponent(STAGING)}/merge_requests/200`;
  switch (url.pathname) {
    case mr: return json(mergeRequest200);
    case `${mr}/closes_issues`: return json([{ title: "[Export] Show the export button", state: "closed", web_url: `https://gitlab.com/${STAGING}/-/issues/100` }]);
    case `${mr}/diffs`: return json(url.searchParams.get("page") === "1" ? diffs200 : []);
    case `${mr}/discussions`: return json(discussions200);
    case "/api/v4/projects/42/pipelines/900/jobs": return json([{ name: "unit-tests", stage: "test", web_url: "https://gitlab.com/jobs/1" }]);
    case `/api/v4/groups/${encodeURIComponent(GROUP)}/issues`:
    case `/api/v4/projects/${encodeURIComponent(PLUGIN)}/issues`: return json(searchHits);
    case "/api/v4/personal_access_tokens/self": return json({ name: "test", scopes: ["read_api"], active: true, revoked: false, expires_at: null });
    default: return json({ message: "404 Not Found" }, 404);
  }
}

export function fakeGitLab(): FakeGitLab {
  const fake: FakeGitLab = {
    requests: [],
    queue: [],
    memory: new Map([[ISSUE_REPORT, { content: "# [Export] The export fails\n\n## Steps to Reproduce\n\n1. Click Export.", version: 3, updatedAt: "2026-10-22T10:00:00Z" }]]),
    updatedAt: new Map(),
    now: Date.now,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      if (url.origin === "http://memory.test") {
        fake.requests.push({ method: init?.method ?? "GET", url, authorization: headers.get("authorization") ?? undefined, operation: undefined, variables: undefined });
        return memoryServer(fake, url, init?.method ?? "GET", headers, typeof init?.body === "string" ? init.body : undefined);
      }
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }) : undefined;
      const operation = body ? /query\s+(\w+)/.exec(body.query)?.[1] : undefined;
      fake.requests.push({ method: init?.method ?? "GET", url, authorization: headers.get("authorization") ?? undefined, operation, variables: body?.variables });
      const queued = fake.queue.shift();
      if (queued) return queued;
      if (url.pathname === "/api/graphql") return json(graphql(fake, operation, body?.variables ?? {}));
      return rest(url);
    }) as typeof fetch,
  };
  return fake;
}

/** A local git repository with a `main` branch and one commit; `commit()` adds another. */
export async function sourceRepository(dir: string): Promise<{ path: string; commit: (file: string, content: string) => Promise<string> }> {
  const { runGit } = await import("../src/repos/git.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(dir, { recursive: true });
  const env = { GIT_AUTHOR_NAME: "dev", GIT_AUTHOR_EMAIL: "dev@example.org", GIT_COMMITTER_NAME: "dev", GIT_COMMITTER_EMAIL: "dev@example.org" };
  await runGit(["init", "--quiet", "--initial-branch=main"], { cwd: dir, env });
  const commit = async (file: string, content: string) => {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), content);
    await runGit(["add", "--all"], { cwd: dir, env });
    await runGit(["commit", "--quiet", "-m", `Change ${file}`], { cwd: dir, env });
    return (await runGit(["rev-parse", "HEAD"], { cwd: dir, env })).trim();
  };
  await commit("src/Export.java", "class Export {\n  void run() {\n    check();\n  }\n}\n");
  return { path: dir, commit };
}
