import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { openApiDocument } from "./api/openapi.js";
import { errorHandler, registerRest } from "./api/rest.js";
import { Authenticator } from "./auth.js";
import type { Config } from "./config.js";
import type { DB } from "./core/db.js";
import { MemoryCore } from "./core/memory-core.js";
import { registerMcp } from "./mcp/server.js";

/** Builds the HTTP application: `/api` (REST), `/mcp` (MCP Streamable HTTP) and `/health`, all on one core. */
export function buildApp(config: Config, db: DB, options: FastifyServerOptions = {}): FastifyInstance {
  const core = new MemoryCore(db, { maxDocumentBytes: config.maxDocumentBytes });
  const auth = new Authenticator(config);
  const app = Fastify({
    // A document plus JSON escaping and the other fields of the request.
    bodyLimit: config.maxDocumentBytes * 2 + 64 * 1024,
    ...options,
  });
  app.setErrorHandler(errorHandler);
  app.get("/health", { logLevel: "warn" }, async () => ({ status: "ok" }));
  const openApi = openApiDocument();
  app.get("/api/openapi.json", async () => openApi);
  registerRest(app, core, auth);
  registerMcp(app, core, auth, config.mcpMaxOutputChars);
  return app;
}
