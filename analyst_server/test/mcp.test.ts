import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ANALYST_TOKEN, fakeGitLab, GROUP, PLUGIN, testConfig } from "./helpers.js";

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = buildApp(testConfig(), {}, { fetch: fakeGitLab().fetch });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app.close();
});

async function connect(token = ANALYST_TOKEN): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown>): Promise<TextResult> {
  const client = await connect();
  try {
    return (await client.callTool({ name, arguments: args })) as TextResult;
  } finally {
    await client.close();
  }
}

describe("HTTP endpoints", () => {
  it("answers /health without a token, /auth-check only with the right one", async () => {
    expect((await fetch(new URL("/health", base))).status).toBe(200);
    expect((await fetch(new URL("/auth-check", base))).status).toBe(401);
    expect((await fetch(new URL("/auth-check", base), { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(new URL("/auth-check", base), { headers: { Authorization: `Bearer ${ANALYST_TOKEN}` } })).status).toBe(204);
  });

  it("refuses MCP requests without the token, and GET on /mcp", async () => {
    await expect(connect("wrong")).rejects.toThrow();
    const response = await fetch(new URL("/mcp", base), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect((await fetch(new URL("/mcp", base))).status).toBe(405);
  });
});

describe("MCP server", () => {
  it("lists the GitLab and analysis tools, all read-only", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "analyst_fix_brief", "analyst_investigate", "analyst_job", "analyst_story_brief", "gitlab_merge_request", "gitlab_search", "gitlab_work_item",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.find((t) => t.name === "gitlab_work_item")!.inputSchema.required).toEqual(["ref"]);
    await client.close();
  });

  it("gitlab_work_item shows the work item, its hierarchy and its merge requests", async () => {
    const result = await call("gitlab_work_item", { ref: "https://gitlab.com/henixdevelopment/squash/squash-tm/core/squashtest-tm-staging/-/work_items/100" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("#100 · UserStory (Issue) · closed · [Export] Show the export button");
    expect(text).toContain("## Acceptance criteria");
    expect(text).toContain(`${GROUP}#10 · Epic · open · Reporting`);
    expect(text).toContain(`  ${GROUP}#11 · Feature · open · [Export] Export campaigns · Status::Implemented`);
    expect(text).toContain("    ▶ #100 (this work item)");
    expect(text).toContain("#101 · UserStory · open · [Export] Export as CSV · Status::InProgress · MRs: opened, merged");
    expect(text).toContain(`${PLUGIN}#5 · Task · closed`);
    expect(text).toContain("- relates_to: #90 · Bug · open");
    expect(text).toContain(`!200 · merged · Resolve "Show the export button" · 100-show-the-export-button → main`);
    expect(text).toContain("## Comments (2, oldest first)");
    expect(text).not.toContain("changed the description");
  });

  it("gitlab_merge_request shows the files, the cut diff, the failed jobs and the discussions", async () => {
    const result = await call("gitlab_merge_request", { ref: "!200", max_diff_chars: 30 });
    const text = result.content[0]!.text;
    expect(text).toContain("closes: #100 · closed");
    expect(text).toContain("failed job: unit-tests (test)");
    expect(text).toContain("## Changed files (3, +2 −1)");
    expect(text).toContain("- renamed front/old.less → front/new.less (+0 −0)");
    expect(text).toMatch(/\(cut: \d+ more characters of this file's diff/);
    expect(text).toContain("(diff not returned by GitLab: too large)");
    expect(text).toContain("### [resolved] reviewer · 2026-10-15T10:00:00Z · front/campaign.html:3");
    expect(text).toContain("(cut: 500 more characters)");
    expect(text).not.toContain("added 1 commit");
  });

  it("gitlab_search lists the hits", async () => {
    const text = (await call("gitlab_search", { query: "export" })).content[0]!.text;
    expect(text).toContain(`"export" in ${GROUP} · 2 work items`);
    expect(text).toContain("#100 · closed · [Export] Show the export button · UserStory/Validated");
  });

  it("returns actionable errors", async () => {
    const wrongKind = await call("gitlab_work_item", { ref: "!200" });
    expect(wrongKind.isError).toBe(true);
    expect(wrongKind.content[0]!.text).toContain("use gitlab_merge_request");
    const otherHost = await call("gitlab_merge_request", { ref: "https://evil.example/a/b/-/merge_requests/1" });
    expect(otherHost.content[0]!.text).toContain("only https://gitlab.com is served");
    const missing = await call("gitlab_work_item", { ref: "#999" });
    expect(missing.content[0]!.text).toContain("not found");
    const badProject = await call("gitlab_search", { query: "x", project: "../etc" });
    expect(badProject.content[0]!.text).toContain("is not a project path");
  });
});

describe("output limit", () => {
  it("truncates long results with a notice", async () => {
    const small = buildApp(testConfig({ mcpMaxOutputChars: 300 }), {}, { fetch: fakeGitLab().fetch });
    const address = await small.listen({ host: "127.0.0.1", port: 0 });
    try {
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", address), { requestInit: { headers: { Authorization: `Bearer ${ANALYST_TOKEN}` } } }));
      const result = (await client.callTool({ name: "gitlab_work_item", arguments: { ref: "#100" } })) as TextResult;
      expect(result.content[0]!.text.length).toBeLessThanOrEqual(300);
      expect(result.content[0]!.text).toMatch(/\[truncated: \d+ more characters not shown\]$/);
      await client.close();
    } finally {
      await small.close();
    }
  });
});
