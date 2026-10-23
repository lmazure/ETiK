import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { AuthError, type Authenticator } from "../auth.js";
import { AnalystError } from "../errors.js";
import type { MergeRequests } from "../gitlab/merge-requests.js";
import { isNamespacePath, parseRef, type RefContext } from "../gitlab/refs.js";
import type { Search } from "../gitlab/search.js";
import type { WorkItems } from "../gitlab/work-items.js";
import { tools, type ToolName } from "../schemas.js";
import { bounded, formatError, type Formatter } from "./format.js";

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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
}

export function buildMcpServer(services: Services, logger: FastifyBaseLogger): McpServer {
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
  return server;
}

function jsonRpcError(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).send({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/**
 * Mounts the stateless Streamable HTTP endpoint on `/mcp`, with SSE responses so that long tools can send
 * progress notifications. Authentication happens before any MCP processing.
 */
export function registerMcp(app: FastifyInstance, services: Services, auth: Authenticator): void {
  app.post("/mcp", async (request, reply) => {
    try {
      auth.authenticate(request.headers.authorization);
    } catch (error) {
      if (error instanceof AuthError) return jsonRpcError(reply.header("WWW-Authenticate", "Bearer"), error.status, error.message);
      throw error;
    }
    const server = buildMcpServer(services, request.log);
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
