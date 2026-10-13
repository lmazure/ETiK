import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { ConfigurationError, MAX_TOTAL_BYTES, relativePath } from "./configuration.js";
import { SessionError, type SessionManager } from "./session.js";
import type { Configuration, ConfigurationStore } from "./store.js";

/** The console is only meant for a browser on the Docker host, through the port published on 127.0.0.1. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export const SECURITY_HEADERS: Record<string, string> = {
  // xterm.js injects <style> elements, hence 'unsafe-inline' for styles only.
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const uploadBody = z.strictObject({
  files: z.array(z.strictObject({ path: z.string(), content: z.base64() })).min(1),
});
const startBody = z.strictObject({
  configuration: z.string(),
  cols: z.number().int().min(20).max(1000).optional(),
  rows: z.number().int().min(5).max(500).optional(),
});
const clientMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("input"), data: z.string() }),
  z.strictObject({ type: z.literal("resize"), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) }),
]);

/** What the page shows of a configuration. */
export function summary(configuration: Configuration) {
  const { config } = configuration;
  return {
    id: configuration.id,
    name: config.name,
    systemPrompt: config.systemPrompt,
    domains: config.domains,
    hostPorts: config.hostPorts,
    tools: {
      builtin: config.tools.builtin,
      mcpServers: Object.entries(config.tools.mcpServers).map(([name, server]) => ({
        name,
        type: typeof server.type === "string" ? server.type : "stdio",
        target: typeof server.url === "string" ? server.url : typeof server.command === "string" ? server.command : "",
      })),
    },
    skills: config.skills,
    env: config.env,
    checks: config.checks.map((check) => check.name),
    files: configuration.files,
    uploadedAt: configuration.uploadedAt,
  };
}

/** The text of a file, or null for binary content (a NUL byte or invalid UTF-8). */
function text(content: Buffer): string | null {
  if (content.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function errorHandler(error: FastifyError | Error, _request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ConfigurationError) return reply.code(error.statusCode).send({ error: error.message, problems: error.problems });
  if (error instanceof SessionError) return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: error.issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`).join("\n") });
  }
  const statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
  if (statusCode >= 500) reply.log.error(error);
  return reply.code(statusCode).send({ error: error.message });
}

export function buildApp(
  store: ConfigurationStore,
  sessions: SessionManager,
  builtinSkills: () => string[],
  webRoot: string | undefined,
  options: FastifyServerOptions = {},
): FastifyInstance {
  // Base64 of the files plus the JSON around them.
  const app = Fastify({ bodyLimit: Math.ceil(MAX_TOTAL_BYTES * 1.4) + 64 * 1024, ...options });
  app.setErrorHandler(errorHandler);
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    return payload;
  });
  // Against DNS rebinding and cross-site requests: only local host names, and only same-origin pages.
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    if (!LOCAL_HOST.test(host) || (origin !== undefined && origin !== `http://${host}`)) {
      return reply.code(403).send({ error: "the console only accepts requests from http://localhost" });
    }
  });

  app.get("/health", { logLevel: "warn" }, async () => ({ status: "ok" }));

  app.get("/api/configurations", async () => ({
    builtinSkills: builtinSkills(),
    configurations: store.list().map((entry) => ("config" in entry ? summary(entry) : entry)),
  }));

  app.put<{ Params: { id: string } }>("/api/configurations/:id", async (request) => {
    const body = uploadBody.parse(request.body);
    const files = new Map<string, Buffer>();
    for (const file of body.files) {
      const path = relativePath(file.path);
      if (files.has(path)) throw new ConfigurationError([`duplicate file '${path}'`]);
      files.set(path, Buffer.from(file.content, "base64"));
    }
    return summary(store.save(request.params.id, files));
  });

  app.get<{ Params: { id: string; "*": string } }>("/api/configurations/:id/files/*", async (request) => {
    const content = store.readFile(request.params.id, request.params["*"]);
    return { path: relativePath(request.params["*"]), size: content.length, content: text(content) };
  });

  app.delete<{ Params: { id: string } }>("/api/configurations/:id", async (request, reply) => {
    const state = sessions.getState();
    if (state.status !== "idle" && state.configuration === request.params.id) {
      throw new SessionError(409, "this configuration is used by the current session");
    }
    store.delete(request.params.id);
    return reply.code(204).send();
  });

  app.get("/api/session", async () => sessions.getState());

  app.post("/api/session", async (request) => {
    const body = startBody.parse(request.body);
    return sessions.start(body.configuration, body.cols, body.rows);
  });

  app.delete("/api/session", async () => {
    sessions.stop();
    return sessions.getState();
  });

  app.register(fastifyWebsocket);
  app.register(async (scope) => {
    // Terminal: the server sends {type: "state"} and {type: "output"}; the page sends {type: "input"} and {type: "resize"}.
    scope.get("/api/terminal", { websocket: true }, (socket) => {
      const send = (message: object) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      };
      send({ type: "state", state: sessions.getState() });
      const scrollback = sessions.getScrollback();
      if (scrollback) send({ type: "output", data: scrollback });
      const unsubscribe = [
        sessions.onState((state) => send({ type: "state", state })),
        sessions.onOutput((data) => send({ type: "output", data })),
      ];
      socket.on("message", (raw: Buffer) => {
        let message: z.infer<typeof clientMessage>;
        try {
          message = clientMessage.parse(JSON.parse(raw.toString("utf8")));
        } catch {
          return;
        }
        if (message.type === "input") sessions.write(message.data);
        else sessions.resize(message.cols, message.rows);
      });
      socket.on("close", () => unsubscribe.forEach((stop) => stop()));
    });
  });

  if (webRoot && existsSync(join(webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: webRoot, prefix: "/", index: "index.html" });
  }
  return app;
}
