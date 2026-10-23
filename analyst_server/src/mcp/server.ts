import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { AuthError, type Authenticator } from "../auth.js";
import type { AnalysisRequest, Analyses } from "../engine/analyses.js";
import type { Job, JobQueue } from "../engine/jobs.js";
import { AnalystError } from "../errors.js";
import type { MergeRequests } from "../gitlab/merge-requests.js";
import { isNamespacePath, parseRef, type RefContext } from "../gitlab/refs.js";
import type { Search } from "../gitlab/search.js";
import type { WorkItems } from "../gitlab/work-items.js";
import { tools, type ToolName } from "../schemas.js";
import { bounded, formatError, formatJob, formatJobLine, formatJobs, type Formatter } from "./format.js";

export const SERVER_NAME = "analyst-server";
export const SERVER_VERSION = "0.1.0";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface Services {
  workItems: WorkItems;
  mergeRequests: MergeRequests;
  search: Search;
  formatter: Formatter;
  refs: RefContext;
  maxOutputChars: number;
}

/** The analyses and their queue. */
export interface Engine {
  analyses: Analyses;
  queue: JobQueue;
  /** Period of the progress notifications sent while an analysis runs. */
  progressIntervalMs: number;
}

type Extra = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message: string } }) => Promise<void>;
};

async function run(logger: FastifyBaseLogger, maxChars: number, produce: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: bounded(await produce(), maxChars) }] };
  } catch (error) {
    if (!(error instanceof AnalystError)) logger.error(error);
    return { content: [{ type: "text", text: formatError(error) }], isError: true };
  }
}

/** Description and annotations of a tool; the input schema is given at registration so that its type is inferred. */
function meta(name: ToolName) {
  return {
    description: tools[name].description,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: !name.startsWith("analyst_"), openWorldHint: true },
  };
}

/**
 * Waits for the job, sending a progress notification at once and then periodically, when the client asked for them.
 * Stops waiting, but not the job, when the request is cancelled or its connection closes.
 */
async function waitFor(job: Job, engine: Engine, extra: Extra): Promise<void> {
  const token = extra._meta?.progressToken;
  let progress = 0;
  const notify = async () => {
    if (token === undefined) return;
    try {
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progress, message: formatJobLine(job, engine.queue.position(job), Date.now()) } });
    } catch {
      // The client went away; the job goes on.
    }
  };
  await notify();
  const timer = setInterval(() => void notify(), engine.progressIntervalMs);
  try {
    await Promise.race([job.finished, new Promise<void>((resolve) => extra.signal.addEventListener("abort", () => resolve(), { once: true }))]);
  } finally {
    clearInterval(timer);
  }
}

async function analyse(engine: Engine, request: AnalysisRequest, extra: Extra): Promise<string> {
  const job = engine.analyses.start(request);
  await waitFor(job, engine, extra);
  if (job.status === "failed") {
    throw new AnalystError("ANALYSIS_FAILED", `Job ${job.id} (${job.kind.replace("_", " ")} of ${job.target}) failed: ${job.error}`);
  }
  if (job.status !== "done") {
    throw new AnalystError("ANALYSIS_FAILED", `Stopped waiting for job ${job.id}; it goes on: get its result later with analyst_job.`);
  }
  return formatJob(job, Date.now());
}

export function buildMcpServer(services: Services, engine: Engine, logger: FastifyBaseLogger): McpServer {
  const { workItems, mergeRequests, search, formatter, refs, maxOutputChars } = services;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  server.registerTool("gitlab_work_item", { ...meta("gitlab_work_item"), inputSchema: tools.gitlab_work_item.schema },
    async (args) => run(logger, maxOutputChars, async () =>
      formatter.workItem(await workItems.get(parseRef(args.ref, "work_item", refs), args.max_comments))));
  server.registerTool("gitlab_merge_request", { ...meta("gitlab_merge_request"), inputSchema: tools.gitlab_merge_request.schema },
    async (args) => run(logger, maxOutputChars, async () =>
      formatter.mergeRequest(await mergeRequests.get(parseRef(args.ref, "merge_request", refs), args.include_diff), args.max_diff_chars, args.include_diff)));
  server.registerTool("gitlab_search", { ...meta("gitlab_search"), inputSchema: tools.gitlab_search.schema },
    async (args) => run(logger, maxOutputChars, async () => {
      if (args.project !== undefined && !isNamespacePath(args.project)) {
        throw new AnalystError("INVALID_ARGUMENT", `'${args.project}' is not a project path such as 'group/subgroup/project'.`);
      }
      const result = await search.run({ ...args, project: args.project });
      return formatter.search(args.query, args.kind, result.scope, result.hits);
    }));

  server.registerTool("analyst_story_brief", { ...meta("analyst_story_brief"), inputSchema: tools.analyst_story_brief.schema },
    async (args, extra) => run(logger, maxOutputChars, () => analyse(engine, { kind: "story_brief", ref: args.ref }, extra as Extra)));
  server.registerTool("analyst_fix_brief", { ...meta("analyst_fix_brief"), inputSchema: tools.analyst_fix_brief.schema },
    async (args, extra) => run(logger, maxOutputChars, () => analyse(engine, { kind: "fix_brief", ref: args.ref }, extra as Extra)));
  server.registerTool("analyst_investigate", { ...meta("analyst_investigate"), inputSchema: tools.analyst_investigate.schema },
    async (args, extra) => run(logger, maxOutputChars, () =>
      analyse(engine, { kind: "investigation", issueReport: args.issue_report, description: args.description }, extra as Extra)));
  server.registerTool("analyst_job", { ...meta("analyst_job"), inputSchema: tools.analyst_job.schema },
    async (args) => run(logger, maxOutputChars, async () => {
      const now = Date.now();
      if (args.job_id) {
        const job = engine.queue.get(args.job_id);
        return job.status === "done" ? formatJob(job, now) : formatJobLine(job, engine.queue.position(job), now);
      }
      return formatJobs(engine.queue.list().map((job) => ({ job, position: engine.queue.position(job) })), now);
    }));
  return server;
}

function jsonRpcError(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).send({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/**
 * Mounts the stateless Streamable HTTP endpoint on `/mcp`, with SSE responses so that long tools can send
 * progress notifications. Authentication happens before any MCP processing.
 */
export function registerMcp(app: FastifyInstance, services: Services, engine: Engine, auth: Authenticator): void {
  app.post("/mcp", async (request, reply) => {
    try {
      auth.authenticate(request.headers.authorization);
    } catch (error) {
      if (error instanceof AuthError) return jsonRpcError(reply.header("WWW-Authenticate", "Bearer"), error.status, error.message);
      throw error;
    }
    const server = buildMcpServer(services, engine, request.log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  const notAllowed = async (_request: unknown, reply: FastifyReply) =>
    jsonRpcError(reply.header("Allow", "POST"), 405, "Method not allowed: this MCP server is stateless, use POST");
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
