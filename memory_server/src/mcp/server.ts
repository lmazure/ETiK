import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { AuthError, STORE_HEADER, headerValue, type Authenticator } from "../auth.js";
import { MemoryError } from "../core/errors.js";
import type { Context, MemoryCore } from "../core/memory-core.js";
import { tools, type ReadArgs, type ToolName } from "../schemas.js";
import {
  formatBatch, formatDelete, formatError, formatHistory, formatList, formatMove, formatRead, formatSearch, formatWrite,
} from "./format.js";

export const SERVER_NAME = "memory-server";
export const SERVER_VERSION = "0.1.0";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

export interface McpLimits {
  /** Maximum size of one text result, in characters. */
  maxOutputChars: number;
  /** Largest image returned by memory_read, in bytes. */
  maxImageBytes: number;
}

async function run(logger: FastifyBaseLogger, produce: () => string | Content[] | Promise<string>): Promise<ToolResult> {
  try {
    const output = await produce();
    return { content: typeof output === "string" ? [{ type: "text", text: output }] : output };
  } catch (error) {
    if (!(error instanceof MemoryError)) logger.error(error);
    return { content: [{ type: "text", text: formatError(error) }], isError: true };
  }
}

/** Description and annotations of a tool; the input schema is given at registration so that its type is inferred. */
function meta(name: ToolName) {
  const tool = tools[name];
  return {
    description: tool.description,
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: name === "memory_delete" || name === "memory_move" || name === "memory_write" || name === "memory_batch",
      idempotentHint: tool.readOnly,
      openWorldHint: false,
    },
  };
}

/** memory_read: the numbered lines of a text document; the metadata of a binary one, followed by the image when small enough. */
function read(core: MemoryCore, ctx: Context, args: ReadArgs, limits: McpLimits): string | Content[] {
  const result = core.read(ctx, args);
  if (result.content_type === undefined) return formatRead(result, limits.maxOutputChars);
  const download = `download it with GET /api/stores/${ctx.store}/files${result.path}` + (result.is_past_version ? `?version=${result.version}` : "");
  if (!result.content_type.startsWith("image/")) return formatRead(result, limits.maxOutputChars, `(not shown: only images are returned; ${download})`);
  if (result.size > limits.maxImageBytes) {
    return formatRead(result, limits.maxOutputChars, `(not shown: larger than the ${limits.maxImageBytes} bytes limit for images; ${download})`);
  }
  const file = core.readFile(ctx, { path: result.path, version: result.version });
  return [
    { type: "text", text: formatRead(result, limits.maxOutputChars) },
    { type: "image", data: file.data.toString("base64"), mimeType: file.content_type },
  ];
}

/** One MCP server per request: the store comes from that request's headers. */
export function buildMcpServer(core: MemoryCore, ctx: Context, limits: McpLimits, logger: FastifyBaseLogger): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  server.registerTool("memory_list", { ...meta("memory_list"), inputSchema: tools.memory_list.schema },
    async (args) => run(logger, () => formatList(core.list(ctx, args))));
  server.registerTool("memory_read", { ...meta("memory_read"), inputSchema: tools.memory_read.schema },
    async (args) => run(logger, () => read(core, ctx, args, limits)));
  server.registerTool("memory_search", { ...meta("memory_search"), inputSchema: tools.memory_search.schema },
    async (args) => run(logger, async () => formatSearch(await core.search(ctx, args))));
  server.registerTool("memory_write", { ...meta("memory_write"), inputSchema: tools.memory_write.schema },
    async (args) => run(logger, () => formatWrite(core.write(ctx, args))));
  server.registerTool("memory_edit", { ...meta("memory_edit"), inputSchema: tools.memory_edit.schema },
    async (args) => run(logger, () => formatWrite(core.edit(ctx, args))));
  server.registerTool("memory_move", { ...meta("memory_move"), inputSchema: tools.memory_move.schema },
    async (args) => run(logger, () => formatMove(core.move(ctx, args))));
  server.registerTool("memory_delete", { ...meta("memory_delete"), inputSchema: tools.memory_delete.schema },
    async (args) => run(logger, () => formatDelete(core.delete(ctx, args))));
  server.registerTool("memory_batch", { ...meta("memory_batch"), inputSchema: tools.memory_batch.schema },
    async (args) => run(logger, () => formatBatch(core.batch(ctx, args))));
  server.registerTool("memory_history", { ...meta("memory_history"), inputSchema: tools.memory_history.schema },
    async (args) => run(logger, () => formatHistory(core.history(ctx, args))));
  return server;
}

function jsonRpcError(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).send({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/** Mounts the stateless Streamable HTTP endpoint on `/mcp`. Authentication happens before any MCP processing. */
export function registerMcp(app: FastifyInstance, core: MemoryCore, auth: Authenticator, limits: McpLimits): void {
  app.post("/mcp", async (request, reply) => {
    let ctx: Context;
    try {
      const principal = auth.authenticate(request.headers.authorization);
      if (principal.role === "viewer") throw new AuthError(403, "The viewer token is for people (web app and REST reads), not for MCP");
      ctx = auth.context(principal, headerValue(request.headers[STORE_HEADER]));
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.status === 401) reply.header("WWW-Authenticate", "Bearer");
        return jsonRpcError(reply, error.status, error.message);
      }
      if (error instanceof MemoryError) return jsonRpcError(reply, 400, error.message);
      throw error;
    }
    const server = buildMcpServer(core, ctx, limits, request.log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
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
