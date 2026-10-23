/**
 * The analyst's own tools, given to the agent as an in-process MCP server: they run in the server process, which
 * holds the GitLab token, so the agent never sees it. GitLab reads reuse the tester's tools; the repository tools
 * check out projects for the job and read their history with validated git commands.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { AnalystError } from "../errors.js";
import { parseRef } from "../gitlab/refs.js";
import { bounded, formatError } from "../mcp/format.js";
import type { Services } from "../mcp/server.js";
import { checkPath, checkRevision, runGit } from "../repos/git.js";
import type { Checkout, Repos } from "../repos/repos.js";
import { mergeRequestArgs, searchArgs, tools as testerTools, workItemArgs } from "../schemas.js";
import { MCP_SERVER_NAME } from "./permissions.js";

const MAX_TOOL_CHARS = 60_000;

export interface AgentToolsContext {
  jobId: string;
  services: Services;
  repos: Repos;
  gitEnv: Record<string, string>;
  gitlabUrl: string;
  /** The job's checkouts, by project; filled by repo_checkout. */
  checkouts: Map<string, Checkout>;
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(produce: () => Promise<string>): Promise<Result> {
  try {
    return { content: [{ type: "text", text: bounded(await produce(), MAX_TOOL_CHARS) }] };
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof AnalystError ? formatError(error) : `Error: ${String(error)}` }], isError: true };
  }
}

const readOnly = { annotations: { readOnlyHint: true } };
const project = z.string().min(1).max(300).describe("A project path, e.g. 'henixdevelopment/squash/squash-tm/core/squashtest-tm-staging'.");

export function agentTools(context: AgentToolsContext): McpSdkServerConfigWithInstance {
  const { services, repos, checkouts } = context;

  const checkedOut = (name: string): Checkout => {
    const checkout = checkouts.get(name);
    if (!checkout) throw new AnalystError("INVALID_ARGUMENT", `'${name}' is not checked out: call repo_checkout first.`);
    return checkout;
  };
  const git = (checkout: Checkout, args: string[]) => runGit(args, { cwd: checkout.path, env: context.gitEnv });

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [
      tool("gitlab_work_item", testerTools.gitlab_work_item.description, workItemArgs.shape, async (args) => run(async () =>
        services.formatter.workItem(await services.workItems.get(parseRef(args.ref, "work_item", services.refs), args.max_comments ?? 50))), readOnly),
      tool("gitlab_merge_request", testerTools.gitlab_merge_request.description, mergeRequestArgs.shape, async (args) => run(async () => {
        const includeDiff = args.include_diff ?? true;
        return services.formatter.mergeRequest(await services.mergeRequests.get(parseRef(args.ref, "merge_request", services.refs), includeDiff), args.max_diff_chars ?? 20_000, includeDiff);
      }), readOnly),
      tool("gitlab_search", testerTools.gitlab_search.description, searchArgs.shape, async (args) => run(async () => {
        const request = { query: args.query, kind: args.kind ?? "work_item", state: args.state ?? "all", labels: args.labels ?? [], project: args.project, limit: args.limit ?? 20 } as const;
        const result = await services.search.run(request);
        return services.formatter.search(request.query, request.kind, result.scope, result.hits);
      }), readOnly),

      tool("repo_list", "List the code projects you may check out (SquashTM core and plugins), with their default branch and description.", {}, async () => run(async () => {
        const projects = await repos.listProjects();
        if (projects.length === 0) return "(no project listed)";
        return projects.map((p) => [p.path, p.defaultBranch ? `default branch ${p.defaultBranch}` : "", p.description.replace(/\s+/g, " ").slice(0, 150)].filter((s) => s !== "").join(" · ")).join("\n");
      }), readOnly),

      tool("repo_checkout", "Check out the head of the default branch of a project for this analysis (clone or update it first). Returns the local path to read with Read, Grep and Glob, the commit SHA to use in permalinks, and the permalink pattern.", { project }, async (args) => run(async () => {
        const checkout = checkouts.get(args.project) ?? await repos.checkout(context.jobId, args.project);
        checkouts.set(args.project, checkout);
        return [
          `${checkout.project} checked out at ${checkout.branch} ${checkout.sha}`,
          `path: ${checkout.path}`,
          `permalinks: ${context.gitlabUrl}/${checkout.project}/-/blob/${checkout.sha}/<path>#L<from>-<to>`,
        ].join("\n");
      }), readOnly),

      tool("git_log", "History of a checked-out project, newest first: SHA, date, author, subject; optionally of one path, or of commits whose message matches `grep`.", {
        project,
        path: z.string().max(500).optional().describe("A file or directory, relative to the project root."),
        grep: z.string().max(200).optional().describe("Only commits whose message contains this text (e.g. an issue number)."),
        max_count: z.number().int().min(1).max(200).default(30),
      }, async (args) => run(async () => {
        const checkout = checkedOut(args.project);
        const options = ["log", `--max-count=${args.max_count ?? 30}`, "--date=short", "--format=%H %ad %an: %s", "--fixed-strings"];
        if (args.grep) options.push(`--grep=${args.grep}`);
        options.push("--");
        if (args.path) options.push(checkPath(checkout.path, args.path));
        return (await git(checkout, options)).trim() || "(no commit)";
      }), readOnly),

      tool("git_show", "Show a commit of a checked-out project (message and patch), or, with `path`, the content of a file at that commit.", {
        project,
        rev: z.string().min(1).max(200).describe("A SHA, branch or tag name, or HEAD~2."),
        path: z.string().max(500).optional().describe("A file, relative to the project root."),
      }, async (args) => run(async () => {
        const checkout = checkedOut(args.project);
        const rev = checkRevision(args.rev);
        if (args.path) return git(checkout, ["show", "--no-textconv", `${rev}:${checkPath(checkout.path, args.path)}`]);
        return git(checkout, ["show", "--no-ext-diff", "--no-textconv", "--stat", "--patch", "--format=fuller", rev, "--"]);
      }), readOnly),

      tool("git_blame", "Who last changed each line of a file of a checked-out project, and in which commit.", {
        project,
        path: z.string().min(1).max(500).describe("A file, relative to the project root."),
        from_line: z.number().int().min(1),
        to_line: z.number().int().min(1),
      }, async (args) => run(async () => {
        const checkout = checkedOut(args.project);
        if (args.to_line < args.from_line) throw new AnalystError("INVALID_ARGUMENT", "to_line must not be before from_line.");
        return git(checkout, ["blame", "--date=short", "-L", `${args.from_line},${args.to_line}`, "--", checkPath(checkout.path, args.path)]);
      }), readOnly),

      tool("git_diff", "Differences between two revisions of a checked-out project, optionally for one path.", {
        project,
        from: z.string().min(1).max(200),
        to: z.string().min(1).max(200).default("HEAD"),
        path: z.string().max(500).optional(),
      }, async (args) => run(async () => {
        const checkout = checkedOut(args.project);
        const options = ["diff", "--no-ext-diff", "--no-textconv", checkRevision(args.from), checkRevision(args.to ?? "HEAD"), "--"];
        if (args.path) options.push(checkPath(checkout.path, args.path));
        return (await git(checkout, options)) || "(no difference)";
      }), readOnly),
    ],
  });
}
