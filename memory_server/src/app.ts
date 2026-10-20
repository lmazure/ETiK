import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { openApiDocument } from "./api/openapi.js";
import { errorHandler, registerRest } from "./api/rest.js";
import { Authenticator } from "./auth.js";
import type { Config } from "./config.js";
import type { DB } from "./core/db.js";
import { MemoryCore } from "./core/memory-core.js";
import { registerMcp } from "./mcp/server.js";

/**
 * The web app shows content written by an agent that browses untrusted pages: no inline script,
 * no external resource, no framing.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/**
 * Builds the HTTP application: `/api` (REST), `/mcp` (MCP Streamable HTTP), `/health`,
 * and the web app at `/` when it has been built. All on one core.
 */
export function buildApp(config: Config, db: DB, options: FastifyServerOptions = {}): FastifyInstance {
  const core = new MemoryCore(db, { maxDocumentBytes: config.maxDocumentBytes, maxFileBytes: config.maxFileBytes });
  const auth = new Authenticator(config);
  const app = Fastify({
    // A text document plus JSON escaping, or a binary one in base64, and the other fields of the request.
    bodyLimit: Math.max(config.maxDocumentBytes * 2, Math.ceil(config.maxFileBytes / 3) * 4) + 64 * 1024,
    ...options,
  });
  app.setErrorHandler(errorHandler);
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    return payload;
  });
  app.get("/health", { logLevel: "warn" }, async () => ({ status: "ok" }));
  const openApi = openApiDocument();
  app.get("/api/openapi.json", async () => openApi);
  registerRest(app, core, auth, config.maxFileBytes);
  registerMcp(app, core, auth, { maxOutputChars: config.mcpMaxOutputChars, maxImageBytes: config.mcpMaxImageBytes });
  if (config.webRoot && existsSync(join(config.webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: config.webRoot, prefix: "/", index: "index.html" });
  }
  return app;
}
