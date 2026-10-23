import { describe, expect, it } from "vitest";
import { AnalystError } from "../src/errors.js";
import { GitLabClient } from "../src/gitlab/client.js";
import { countLines, MergeRequests } from "../src/gitlab/merge-requests.js";
import { Search } from "../src/gitlab/search.js";
import { WorkItems } from "../src/gitlab/work-items.js";
import { fakeGitLab, GITLAB_TOKEN, GROUP, json, PLUGIN, STAGING } from "./helpers.js";

const refs = { gitlabUrl: "https://gitlab.com", defaultProject: STAGING };

function setup() {
  const fake = fakeGitLab();
  const client = new GitLabClient({ baseUrl: "https://gitlab.com", token: GITLAB_TOKEN, timeoutMs: 1_000, fetch: fake.fetch, sleep: async () => {} });
  return { fake, client };
}

async function rejection(promise: Promise<unknown>): Promise<AnalystError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AnalystError) return e;
    throw e;
  }
  throw new Error("no rejection");
}

describe("GitLabClient", () => {
  it("only calls the configured instance, with the token as a bearer", async () => {
    const { fake, client } = setup();
    await client.rest("/personal_access_tokens/self");
    await client.graphql("query AnalystWorkItemFamily { x }", { fullPath: GROUP, iid: "10" });
    expect(fake.requests.map((r) => `${r.method} ${r.url.origin}${r.url.pathname}`)).toEqual([
      "GET https://gitlab.com/api/v4/personal_access_tokens/self",
      "POST https://gitlab.com/api/graphql",
    ]);
    expect(fake.requests.every((r) => r.authorization === `Bearer ${GITLAB_TOKEN}`)).toBe(true);
  });

  it("maps HTTP errors to actionable errors", async () => {
    const { fake, client } = setup();
    expect((await rejection(client.rest("/nope"))).code).toBe("NOT_FOUND");
    fake.queue.push(json({ message: "401 Unauthorized" }, 401));
    expect((await rejection(client.rest("/x"))).message).toContain("renew GITLAB_READ_TOKEN");
    fake.queue.push(json({ message: "403 Forbidden" }, 403));
    expect((await rejection(client.rest("/x"))).code).toBe("FORBIDDEN");
    fake.queue.push(new Response("oops", { status: 502 }));
    expect((await rejection(client.rest("/x"))).code).toBe("GITLAB_UNAVAILABLE");
  });

  it("retries once after a 429, then gives up", async () => {
    const { fake, client } = setup();
    fake.queue.push(json({}, 429, { "Retry-After": "2" }));
    expect(await client.rest("/personal_access_tokens/self")).toMatchObject({ name: "test" });
    fake.queue.push(json({}, 429), json({}, 429));
    expect((await rejection(client.rest("/personal_access_tokens/self"))).message).toContain("rate limit");
  });

  it("reports GraphQL errors and unreachable GitLab", async () => {
    const { client } = setup();
    expect((await rejection(client.graphql("query Unknown { x }", {}))).message).toContain("unknown operation Unknown");
    const down = new GitLabClient({ baseUrl: "https://gitlab.com", token: "t", timeoutMs: 1_000, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect((await rejection(down.rest("/x"))).code).toBe("GITLAB_UNAVAILABLE");
  });
});

describe("WorkItems", () => {
  it("reads a work item with its hierarchy, merge requests and comments", async () => {
    const { client } = setup();
    const item = await new WorkItems(client, refs).get({ kind: "work_item", path: STAGING, iid: 100 }, 50);
    expect(item).toMatchObject({
      title: "[Export] Show the export button", type: "Issue", state: "CLOSED", status: "Done", milestone: "Sprint 158",
      assignees: ["qa"], author: "po", weight: 4, customFields: [{ name: "Dev Weight", value: "3" }],
      labels: ["Priority::Medium", "Status::Validated", "Type::UserStory"],
    });
    expect(item.description).toContain("## Acceptance criteria");
    expect(item.ancestors.map((a) => `${a.ref.path}#${a.ref.iid}`)).toEqual([`${GROUP}#10`, `${GROUP}#11`]);
    expect(item.siblings.map((s) => [`${s.ref.path}#${s.ref.iid}`, s.mergeRequestStates])).toEqual([
      [`${STAGING}#101`, ["opened", "merged"]],
      [`${PLUGIN}#5`, ["merged"]],
    ]);
    expect(item.linkedItems).toMatchObject([{ linkType: "RELATES_TO", item: { title: "[Export] Old export issue" } }]);
    expect(item.mergeRequests.map((mr) => [mr.ref.iid, mr.state, mr.mergeCommitSha])).toEqual([[200, "merged", "a".repeat(40)], [201, "opened", undefined]]);
    expect(item.mergeRequestStates).toEqual(["merged", "opened"]);
    expect(item.comments.map((c) => c.body)).toEqual(["Implemented, on nightly.", "Validated on nightly 19/10."]);
    expect(item.commentsTotal).toBe(2);
  });

  it("keeps the last comments only", async () => {
    const { client } = setup();
    const item = await new WorkItems(client, refs).get({ kind: "work_item", path: STAGING, iid: 100 }, 1);
    expect(item.comments.map((c) => c.author)).toEqual(["qa"]);
    expect(item.commentsTotal).toBe(2);
  });

  it("says when a work item does not exist", async () => {
    const { client } = setup();
    const error = await rejection(new WorkItems(client, refs).get({ kind: "work_item", path: STAGING, iid: 999 }, 50));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain(`${STAGING}#999`);
  });
});

describe("MergeRequests", () => {
  it("reads a merge request with its files, failed jobs and discussions", async () => {
    const { client } = setup();
    const mr = await new MergeRequests(client, refs).get({ kind: "merge_request", path: STAGING, iid: 200 }, true);
    expect(mr).toMatchObject({
      state: "merged", mergedBy: "lead", mergeCommitSha: "a".repeat(40), sourceBranch: "100-show-the-export-button", targetBranch: "main",
      pipeline: { status: "failed", failedJobs: [{ name: "unit-tests", stage: "test" }] }, filesTruncated: false,
    });
    expect(mr.closesIssues.map((i) => i.ref.iid)).toEqual([100]);
    expect(mr.files.map((f) => [f.status, f.newPath, f.added, f.removed, f.diffMissing])).toEqual([
      ["modified", "front/campaign.html", 2, 1, false],
      ["renamed", "front/new.less", 0, 0, false],
      ["added", "front/big.json", 0, 0, true],
    ]);
    expect(mr.discussions).toHaveLength(2);
    expect(mr.discussions[0]).toMatchObject({ resolved: true, notes: [{ author: "reviewer", position: "front/campaign.html:3" }, { body: "Done." }] });
    expect(mr.discussions[1]!.resolved).toBeUndefined();
  });

  it("leaves the diffs out when not asked", async () => {
    const { client } = setup();
    const mr = await new MergeRequests(client, refs).get({ kind: "merge_request", path: STAGING, iid: 200 }, false);
    expect(mr.files[0]).toMatchObject({ diff: "", added: 2, removed: 1 });
  });

  it("counts added and removed lines, not the file headers", () => {
    expect(countLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+c\n d")).toEqual({ added: 2, removed: 1 });
  });
});

describe("Search", () => {
  it("searches the group, or one project", async () => {
    const { fake, client } = setup();
    const search = new Search(client, refs, GROUP);
    const result = await search.run({ query: "export", kind: "work_item", state: "all", labels: ["Type::UserStory"], project: undefined, limit: 5 });
    expect(result.scope).toBe(GROUP);
    expect(result.hits.map((h) => `${h.ref.path}#${h.ref.iid}`)).toEqual([`${STAGING}#100`, `${PLUGIN}#5`]);
    const query = fake.requests[0]!.url.searchParams;
    expect([query.get("search"), query.get("labels"), query.get("per_page"), query.get("state")]).toEqual(["export", "Type::UserStory", "5", null]);

    await search.run({ query: "export", kind: "work_item", state: "closed", labels: [], project: PLUGIN, limit: 5 });
    expect(fake.requests[1]!.url.pathname).toBe(`/api/v4/projects/${encodeURIComponent(PLUGIN)}/issues`);
    expect(fake.requests[1]!.url.searchParams.get("state")).toBe("closed");
  });
});
